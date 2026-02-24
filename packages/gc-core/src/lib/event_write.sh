#!/usr/bin/env bash
# event_write.sh -- Core event writing pipeline for GlobalContext.
# Constructs the 7-field event envelope, assigns a sequence number under flock,
# validates, writes atomically, and updates per-session metadata.
# This is the critical path for the capture-event script.
#
# Pipeline:
#   1. Sanitize session_id
#   2. Ensure session directory exists
#   3. Acquire flock (timeout 5s; orphan fallback on timeout)
#   4. Determine next sequence number
#   5. Generate event_id (UUID v4) and timestamp (ISO 8601 UTC)
#   6. Construct envelope JSON (7 fields)
#   7. Validate envelope
#   8. Write atomically
#   9. Update session.json within same flock scope
#  10. Release flock
#  11. On validation failure: write to _rejected/
set -euo pipefail

# Source dependencies
_EVENT_WRITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "${_EVENT_WRITE_DIR}/paths.sh"
# shellcheck source=sanitize.sh
source "${_EVENT_WRITE_DIR}/sanitize.sh"
# shellcheck source=session_dir.sh
source "${_EVENT_WRITE_DIR}/session_dir.sh"
# shellcheck source=atomic_write.sh
source "${_EVENT_WRITE_DIR}/atomic_write.sh"
# shellcheck source=json_validate.sh
source "${_EVENT_WRITE_DIR}/json_validate.sh"
# shellcheck source=session_meta.sh
source "${_EVENT_WRITE_DIR}/session_meta.sh"
# shellcheck source=rejected.sh
source "${_EVENT_WRITE_DIR}/rejected.sh"

# _gc_generate_uuid()
#   Generates a UUID v4 string. Tries /proc, then uuidgen, then pseudo-random.
_gc_generate_uuid() {
  if [[ -r /proc/sys/kernel/random/uuid ]]; then
    cat /proc/sys/kernel/random/uuid
  elif command -v uuidgen &>/dev/null; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  else
    # Fallback: pseudo-random UUID v4 (RFC 4122 compliant)
    # Version nibble = 4, variant bits = 10xx
    printf '%04x%04x-%04x-%04x-%04x-%04x%04x%04x' \
      $RANDOM $RANDOM \
      $RANDOM \
      $(( (RANDOM & 0x0FFF) | 0x4000 )) \
      $(( (RANDOM & 0x3FFF) | 0x8000 )) \
      $RANDOM $RANDOM $RANDOM
  fi
}

# _gc_iso_timestamp()
#   Returns current UTC time in ISO 8601 format with milliseconds.
#   Falls back to no-millisecond format if %3N is not supported (e.g., macOS).
_gc_iso_timestamp() {
  local ms_check
  ms_check="$(date -u +"%3N" 2>/dev/null)"
  if [[ "$ms_check" =~ ^[0-9]{3}$ ]]; then
    date -u +"%Y-%m-%dT%H:%M:%S.%3NZ"
  else
    date -u +"%Y-%m-%dT%H:%M:%SZ"
  fi
}

# _gc_next_sequence(session_dir)
#   Counts existing [0-9]*.json files (excluding session.json) and returns
#   the next sequence number. Returns 1 if no event files exist.
_gc_next_sequence() {
  local session_dir="$1"
  local highest=0

  # List files matching [0-9]*.json, exclude session.json
  local files
  files="$(find "$session_dir" -maxdepth 1 -name '[0-9]*.json' -not -name 'session.json' 2>/dev/null || true)"

  if [[ -z "$files" ]]; then
    printf '%d' 1
    return
  fi

  local f base num
  while IFS= read -r f; do
    base="$(basename "$f" .json)"
    # Strip leading zeros for arithmetic
    num=$((10#$base))
    if (( num > highest )); then
      highest=$num
    fi
  done <<< "$files"

  printf '%d' $(( highest + 1 ))
}

# gc_write_event(session_id, event_type, data_json)
#
#   Writes an event to the event store. Returns 0 on success, 1 on failure.
#
#   Arguments:
#     session_id  - raw session identifier (will be sanitized)
#     event_type  - the event type string (e.g., "TurnCompleted")
#     data_json   - JSON object for the data field (must be a valid JSON object)
#
#   Environment:
#     GC_PROJECT_DIR - project directory for deriving project_id (defaults to PWD)
#
#   Outputs:
#     stdout - path to the written event file on success
#     stderr - error/warning messages
gc_write_event() {
  local session_id="${1:?gc_write_event requires session_id as \$1}"
  local event_type="${2:?gc_write_event requires event_type as \$2}"
  local data_json="${3:?gc_write_event requires data_json as \$3}"

  # Step 1: Sanitize session_id
  local sanitized_session_id
  sanitized_session_id="$(gc_sanitize_session_id "$session_id")"

  # Derive project_id from GC_PROJECT_DIR or PWD
  local project_dir="${GC_PROJECT_DIR:-$PWD}"
  local project_id
  project_id="$(gc_derive_project_id "$project_dir")"

  # Step 2: Ensure session directory exists
  local session_dir
  session_dir="$(gc_ensure_session_dir "$project_id" "$sanitized_session_id")"

  # Step 3: Acquire flock with 5-second timeout
  local lock_file="$session_dir/.lock"
  local flock_acquired=true

  # Open lock file on fd 9
  exec 9>"$lock_file"

  if ! flock -w 5 9; then
    flock_acquired=false
    echo "gc_write_event: flock timeout after 5s, writing as orphan" >&2
  fi

  if [[ "$flock_acquired" == "true" ]]; then
    # ---- BEGIN CRITICAL SECTION (under flock) ----

    # Step 4: Determine next sequence number
    local sequence
    sequence="$(_gc_next_sequence "$session_dir")"

    # Check sequence limit
    if (( sequence > 999999 )); then
      echo "gc_write_event: sequence limit reached (999999), cannot write" >&2
      exec 9>&-
      return 1
    fi

    # Step 5: Generate event_id and timestamp
    local event_id timestamp
    event_id="$(_gc_generate_uuid)"
    timestamp="$(_gc_iso_timestamp)"

    # Step 6: Construct envelope JSON (compact, single line)
    # Note: session_id in the envelope preserves the original (unsanitized) value.
    # The sanitized version is used only for directory paths.
    local envelope
    envelope="$(jq -c -n \
      --arg eid "$event_id" \
      --arg etype "$event_type" \
      --arg pid "$project_id" \
      --arg sid "$session_id" \
      --argjson seq "$sequence" \
      --arg ts "$timestamp" \
      --argjson data "$data_json" \
      '{
        event_id: $eid,
        event_type: $etype,
        project_id: $pid,
        session_id: $sid,
        sequence: $seq,
        timestamp: $ts,
        data: $data
      }')"

    # Step 7: Validate envelope
    if ! gc_validate_event_json "$envelope" 2>/dev/null; then
      # Validation failed -- write to _rejected/
      local reject_reason
      reject_reason="$(gc_validate_event_json "$envelope" 2>&1 || true)"
      gc_write_rejected_event "$project_id" "$sanitized_session_id" "$envelope" "$reject_reason" >/dev/null
      exec 9>&-
      return 1
    fi

    # Step 8: Write atomically
    local padded_seq filename target_path
    padded_seq="$(printf "%06d" "$sequence")"
    filename="${padded_seq}.json"
    target_path="$session_dir/$filename"

    if ! gc_atomic_write "$target_path" "$envelope" false; then
      echo "gc_write_event: atomic write failed for $target_path" >&2
      exec 9>&-
      return 1
    fi

    # Step 9: Update session.json within flock scope
    if [[ ! -f "$session_dir/session.json" ]]; then
      # First event: create session.json
      gc_session_meta_create "$session_dir" "$sanitized_session_id" "$project_id" \
        "$project_dir" "claude-code" "unknown" "$timestamp"
    else
      # Subsequent events: update session.json
      gc_session_meta_update "$session_dir" "$event_type" "$timestamp"
    fi

    # Step 10: Release flock (close fd 9)
    exec 9>&-

    # Output the path to the written event file
    printf '%s' "$target_path"
    return 0

  else
    # ---- ORPHAN FALLBACK (flock timeout) ----

    # Close the fd (we didn't get the lock)
    exec 9>&-

    # Generate event_id, timestamp, and orphan filename
    local event_id timestamp orphan_uuid orphan_filename
    event_id="$(_gc_generate_uuid)"
    timestamp="$(_gc_iso_timestamp)"
    orphan_uuid="$(_gc_generate_uuid)"
    orphan_filename="orphan-${orphan_uuid}.json"

    # We don't have the lock, so sequence is unknown. Use 0 as placeholder.
    # The projection engine will reconcile orphans.
    # Note: session_id in the envelope preserves the original (unsanitized) value.
    local envelope
    envelope="$(jq -c -n \
      --arg eid "$event_id" \
      --arg etype "$event_type" \
      --arg pid "$project_id" \
      --arg sid "$session_id" \
      --argjson seq 0 \
      --arg ts "$timestamp" \
      --argjson data "$data_json" \
      '{
        event_id: $eid,
        event_type: $etype,
        project_id: $pid,
        session_id: $sid,
        sequence: $seq,
        timestamp: $ts,
        data: $data
      }')"

    local target_path="$session_dir/$orphan_filename"

    if ! gc_atomic_write "$target_path" "$envelope" false; then
      echo "gc_write_event: orphan atomic write failed for $target_path" >&2
      return 1
    fi

    printf '%s' "$target_path"
    return 0
  fi
}
