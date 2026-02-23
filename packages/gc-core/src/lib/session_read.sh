#!/usr/bin/env bash
# session_read.sh -- Per-session session.json read model with derived fields
# Reads session.json and computes state, duration_seconds at read time.
# Part of Story 05, Task 02.
set -euo pipefail

# Source dependencies
_SESSION_READ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "${_SESSION_READ_DIR}/paths.sh"

# _gc_date_to_epoch(date_string)
#
# Portable date-to-epoch conversion. Tries GNU date, then macOS date, then python3.
# Outputs epoch seconds to stdout. Returns 0 on failure.
_gc_date_to_epoch() {
  local date_str="$1"
  local epoch

  # Try GNU date -d
  epoch="$(date -d "$date_str" +%s 2>/dev/null)" && { printf '%s' "$epoch"; return; }

  # Try macOS/BSD date -j -f (ISO 8601 format)
  epoch="$(date -j -f "%Y-%m-%dT%H:%M:%S" "${date_str%%.*}" +%s 2>/dev/null)" && { printf '%s' "$epoch"; return; }
  epoch="$(date -j -f "%Y-%m-%d %H:%M:%S" "${date_str%%.*}" +%s 2>/dev/null)" && { printf '%s' "$epoch"; return; }

  # Fallback to python3
  epoch="$(python3 -c "
import sys, datetime
try:
    s = sys.argv[1].replace('Z','+00:00')
    dt = datetime.datetime.fromisoformat(s)
    print(int(dt.timestamp()))
except Exception:
    print(0)
" "$date_str" 2>/dev/null)" && { printf '%s' "$epoch"; return; }

  printf '0'
}

# gc_read_session_with_derived(project_id, session_id)
#
# Reads session.json from the session's events directory and adds derived fields:
#   state: "ended" | "compacted" | "orphaned" | "active"
#   duration_seconds: integer seconds between started_at and ended_at (or last_event_at)
#
# Outputs enriched JSON to stdout. Returns 1 on error.
gc_read_session_with_derived() {
  local project_id="$1"
  local session_id="$2"

  local session_dir
  session_dir="$(gc_session_events_dir "$project_id" "$session_id")"
  local session_file="${session_dir}/session.json"

  if [[ ! -f "$session_file" ]]; then
    echo "gc_read_session_with_derived: session.json not found for ${project_id}/${session_id}" >&2
    return 1
  fi

  local meta
  meta="$(cat "$session_file" 2>/dev/null)" || {
    echo "gc_read_session_with_derived: failed to read session.json" >&2
    return 1
  }

  # Validate it is parseable JSON
  if ! printf '%s' "$meta" | jq empty 2>/dev/null; then
    echo "gc_read_session_with_derived: session.json is not valid JSON" >&2
    return 1
  fi

  # Determine state
  local state="active"
  local ended_at
  ended_at="$(printf '%s' "$meta" | jq -r '.ended_at // empty')"
  local last_event_type
  last_event_type="$(printf '%s' "$meta" | jq -r '.last_event_type // empty')"

  if [[ -n "$ended_at" ]]; then
    state="ended"
  elif [[ "$last_event_type" == "CompactionTriggered" ]]; then
    state="compacted"
  else
    # Check if orphaned (no events for 24h+)
    local last_event_at
    last_event_at="$(printf '%s' "$meta" | jq -r '.last_event_at // empty')"
    if [[ -n "$last_event_at" ]]; then
      local last_epoch now_epoch
      last_epoch="$(_gc_date_to_epoch "$last_event_at")"
      now_epoch="$(date +%s)"
      local diff=$(( now_epoch - last_epoch ))
      if [[ "$diff" -gt 86400 ]]; then
        state="orphaned"
      fi
    fi
  fi

  # Compute duration_seconds
  local started_at
  started_at="$(printf '%s' "$meta" | jq -r '.started_at // empty')"
  local duration_seconds=0

  if [[ -n "$started_at" ]]; then
    local end_time
    if [[ -n "$ended_at" ]]; then
      end_time="$ended_at"
    else
      end_time="$(printf '%s' "$meta" | jq -r '.last_event_at // empty')"
    fi

    if [[ -n "$end_time" ]]; then
      local start_epoch end_epoch
      start_epoch="$(_gc_date_to_epoch "$started_at")"
      end_epoch="$(_gc_date_to_epoch "$end_time")"
      if [[ "$start_epoch" -gt 0 && "$end_epoch" -gt 0 ]]; then
        duration_seconds=$(( end_epoch - start_epoch ))
        if [[ "$duration_seconds" -lt 0 ]]; then
          duration_seconds=0
        fi
      fi
    fi
  fi

  # Add derived fields to the JSON
  printf '%s' "$meta" | jq \
    --arg state "$state" \
    --argjson duration "$duration_seconds" \
    '. + {state: $state, duration_seconds: $duration}'
}
