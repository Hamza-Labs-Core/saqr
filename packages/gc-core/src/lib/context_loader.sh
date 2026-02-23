#!/usr/bin/env bash
# context_loader.sh -- Context projection builder integration
# Loads or rebuilds a session's context.json projection.
# Part of Story 05, Task 09.
set -euo pipefail

# Source dependencies
_CONTEXT_LOADER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "${_CONTEXT_LOADER_DIR}/paths.sh"
# shellcheck source=projection_check.sh
source "${_CONTEXT_LOADER_DIR}/projection_check.sh"

# _is_system_prompt(text)
#
# Returns 0 (true) if the prompt looks like a system-generated message
# rather than an actual user prompt. These come through UserPromptSubmit
# but are injected by Claude Code (task notifications, skill expansions, etc).
# Uses strict matching: requires both opening AND closing tags to avoid
# misclassifying real user messages that mention these tags.
_is_system_prompt() {
  local text="$1"
  # Require both opening and closing tag (or a second system tag)
  # to avoid false positives on user messages that mention tags
  [[ "$text" == '<task-notification>'* && "$text" == *'</task-notification>'* ]] && return 0
  [[ "$text" == '<task-notification>'* && "$text" == *'<task-id>'* ]] && return 0
  [[ "$text" == '<task-id>'* && "$text" == *'</task-id>'* ]] && return 0
  [[ "$text" == '<output-file>'* && "$text" == *'</output-file>'* ]] && return 0
  [[ "$text" == '<system-reminder>'* && "$text" == *'</system-reminder>'* ]] && return 0
  [[ "$text" == '<command-name>'* && "$text" == *'</command-name>'* ]] && return 0
  [[ "$text" == '<command-message>'* && "$text" == *'</command-message>'* ]] && return 0
  return 1
}

# load_context(project_id, session_id)
#
# Loads the context projection for a session. If current, reads from cache.
# If stale or missing, attempts rebuild via `project` CLI, then reads result.
# If rebuild fails, builds a degraded context from raw events.
# Outputs context JSON to stdout. Returns 1 on total failure.
load_context() {
  local project_id="${1:?load_context: project_id required}"
  local session_id="${2:?load_context: session_id required}"

  local proj_file="$GC_PROJECTIONS_DIR/$project_id/$session_id/context.json"

  # Check if projection is current
  if is_projection_current "$project_id" "$session_id" "context"; then
    cat "$proj_file"
    return 0
  fi

  # Try to rebuild using the project CLI
  build_context_if_needed "$project_id" "$session_id"

  # Read the rebuilt projection
  if [[ -f "$proj_file" ]]; then
    cat "$proj_file"
    return 0
  fi

  # Degraded: build minimal context from raw events
  _build_degraded_context "$project_id" "$session_id"
}

# build_context_if_needed(project_id, session_id)
#
# Builds context projection if stale or missing. Does not output.
# Used by PreCompact hook (Task 14) to eagerly build.
build_context_if_needed() {
  local project_id="${1:?build_context_if_needed: project_id required}"
  local session_id="${2:?build_context_if_needed: session_id required}"

  if is_projection_current "$project_id" "$session_id" "context"; then
    return 0
  fi

  # Try calling the project CLI if it exists
  local project_bin="$GC_BIN_DIR/project"
  if [[ -x "$project_bin" ]]; then
    "$project_bin" context "$session_id" --project "$project_id" >/dev/null 2>/dev/null || true
    return 0
  fi

  # project CLI not available -- build minimal projection from events
  _build_minimal_projection "$project_id" "$session_id"
}

# _build_degraded_context(project_id, session_id)
#
# Builds a minimal context JSON from raw events when the projection engine fails.
_build_degraded_context() {
  local project_id="$1"
  local session_id="$2"

  local events_dir="$GC_EVENTS_DIR/$project_id/$session_id"
  local session_file="$events_dir/session.json"

  local started_at="" last_prompt="" event_count=0 last_event_at="" previous_session_id=""
  local prompts="[]"

  if [[ -f "$session_file" ]]; then
    started_at="$(jq -r '.started_at // empty' "$session_file" 2>/dev/null)"
    last_prompt="$(jq -r '.last_prompt // empty' "$session_file" 2>/dev/null)"
    event_count="$(jq -r '.event_count // 0' "$session_file" 2>/dev/null)"
    last_event_at="$(jq -r '.last_event_at // empty' "$session_file" 2>/dev/null)"
    previous_session_id="$(jq -r '.previous_session_id // empty' "$session_file" 2>/dev/null)"
  fi

  # Scan events for prompts and count
  if [[ -d "$events_dir" ]]; then
    local file_count=0
    for f in "$events_dir"/[0-9]*.json; do
      [[ -f "$f" ]] || continue
      file_count=$((file_count + 1))

      local etype
      etype="$(jq -r '.event_type // empty' "$f" 2>/dev/null)" || continue
      if [[ "$etype" == "UserPromptReceived" ]]; then
        local prompt_text seq_num base
        prompt_text="$(jq -r '.data.prompt // .data.message // empty' "$f" 2>/dev/null)" || true
        base="$(basename "$f" .json)"
        seq_num=$((10#$base))
        if [[ -n "$prompt_text" ]] && ! _is_system_prompt "$prompt_text"; then
          last_prompt="$prompt_text"
          prompts="$(printf '%s' "$prompts" | jq --arg p "$prompt_text" --argjson seq "$seq_num" '. + [{prompt: $p, sequence: $seq}]')"
        fi
      fi
    done
    # Use file count if session.json had 0
    if [[ "$event_count" -eq 0 ]]; then
      event_count=$file_count
    fi
  fi

  local prev_json="null"
  [[ -n "$previous_session_id" ]] && prev_json="\"$previous_session_id\""

  jq -n \
    --arg project_id "$project_id" \
    --arg session_id "$session_id" \
    --arg started_at "${started_at:-unknown}" \
    --arg last_event_at "${last_event_at:-unknown}" \
    --arg last_prompt "${last_prompt:-}" \
    --argjson prompts "$prompts" \
    --argjson event_count "$event_count" \
    --argjson previous_session_id "$prev_json" \
    '{
      "_projection": "context",
      "_project_id": $project_id,
      "_session_id": $session_id,
      "_rebuilt_at": "degraded",
      "_event_count": $event_count,
      "_last_sequence": $event_count,
      "_degraded": true,
      "data": {
        "session_id": $session_id,
        "project_id": $project_id,
        "started_at": $started_at,
        "last_event_at": $last_event_at,
        "event_count": $event_count,
        "last_prompt": $last_prompt,
        "prompts": $prompts,
        "previous_session_id": $previous_session_id,
        "actions": [],
        "files_modified": [],
        "decisions": [],
        "error": "Projection engine unavailable. Showing degraded context."
      }
    }'
}

# _build_minimal_projection(project_id, session_id)
#
# Scans raw events and writes a minimal context.json projection file.
_build_minimal_projection() {
  local project_id="$1"
  local session_id="$2"

  local events_dir="$GC_EVENTS_DIR/$project_id/$session_id"
  [[ -d "$events_dir" ]] || return 0

  local proj_dir="$GC_PROJECTIONS_DIR/$project_id/$session_id"
  mkdir -p "$proj_dir"

  local event_count=0 last_seq=0
  local started_at="" last_event_at="" last_prompt="" previous_session_id=""
  local actions="[]" files_modified="[]" prompts="[]" responses="[]"

  # Read previous_session_id from session.json if available
  local session_file="$events_dir/session.json"
  if [[ -f "$session_file" ]]; then
    previous_session_id="$(jq -r '.previous_session_id // empty' "$session_file" 2>/dev/null)" || true
  fi

  for f in "$events_dir"/[0-9]*.json; do
    [[ -f "$f" ]] || continue
    event_count=$((event_count + 1))

    local base seq_num
    base="$(basename "$f" .json)"
    seq_num=$((10#$base))
    if (( seq_num > last_seq )); then
      last_seq=$seq_num
    fi

    local etype ts
    etype="$(jq -r '.event_type // empty' "$f" 2>/dev/null)" || continue
    ts="$(jq -r '.timestamp // empty' "$f" 2>/dev/null)" || continue

    if [[ "$etype" == "SessionStarted" && -z "$started_at" ]]; then
      started_at="$ts"
    fi
    last_event_at="$ts"

    if [[ "$etype" == "UserPromptReceived" ]]; then
      local prompt_text
      prompt_text="$(jq -r '.data.prompt // .data.message // empty' "$f" 2>/dev/null)" || true
      if [[ -n "$prompt_text" ]] && ! _is_system_prompt "$prompt_text"; then
        last_prompt="$prompt_text"
        prompts="$(printf '%s' "$prompts" | jq --arg p "$prompt_text" --argjson seq "$seq_num" '. + [{prompt: $p, sequence: $seq}]')"
      fi
    fi

    if [[ "$etype" == "TurnCompleted" ]]; then
      local response_text
      response_text="$(jq -r '.data.response // empty' "$f" 2>/dev/null)" || true
      if [[ -n "$response_text" ]]; then
        responses="$(printf '%s' "$responses" | jq --arg r "$response_text" --argjson seq "$seq_num" '. + [{response: $r, sequence: $seq}]')"
      fi
    fi
  done

  local rebuilt_at
  rebuilt_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  local prev_json="null"
  [[ -n "$previous_session_id" ]] && prev_json="\"$previous_session_id\""

  jq -n \
    --arg project_id "$project_id" \
    --arg session_id "$session_id" \
    --arg rebuilt_at "$rebuilt_at" \
    --argjson event_count "$event_count" \
    --argjson last_sequence "$last_seq" \
    --arg started_at "${started_at:-unknown}" \
    --arg last_event_at "${last_event_at:-unknown}" \
    --arg last_prompt "${last_prompt:-}" \
    --argjson prompts "$prompts" \
    --argjson responses "$responses" \
    --argjson actions "$actions" \
    --argjson files_modified "$files_modified" \
    --argjson previous_session_id "$prev_json" \
    '{
      "_projection": "context",
      "_project_id": $project_id,
      "_session_id": $session_id,
      "_rebuilt_at": $rebuilt_at,
      "_event_count": $event_count,
      "_last_sequence": $last_sequence,
      "data": {
        "session_id": $session_id,
        "project_id": $project_id,
        "started_at": $started_at,
        "last_event_at": $last_event_at,
        "event_count": $event_count,
        "last_prompt": $last_prompt,
        "prompts": $prompts,
        "responses": $responses,
        "previous_session_id": $previous_session_id,
        "actions": $actions,
        "files_modified": $files_modified,
        "decisions": []
      }
    }' > "$proj_dir/context.json"
}
