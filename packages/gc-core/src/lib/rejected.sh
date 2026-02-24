#!/usr/bin/env bash
# rejected.sh -- Write rejected events to _rejected/ directory.
# Events that fail validation are preserved here for debugging.
# Rejected files do not participate in sequence numbering and do not need flock.
set -euo pipefail

# Source dependencies
_REJECTED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "${_REJECTED_DIR}/paths.sh"
# shellcheck source=atomic_write.sh
source "${_REJECTED_DIR}/atomic_write.sh"

# gc_write_rejected_event(project_id, session_id, content, error_reason)
#
# Writes a rejected event file to:
#   $GC_EVENTS_DIR/{project_id}/{session_id}/_rejected/{timestamp}-{uuid}.json
#
# The file contains:
#   {
#     "_rejected_at": "<ISO 8601>",
#     "_reason": "<error_reason>",
#     "_original_content": "<content or truncated preview>"
#   }
#
# No flock needed -- rejected files do not participate in sequencing.
# Uses atomic write (Task 04) to avoid partial files.
gc_write_rejected_event() {
  local project_id="${1:?gc_write_rejected_event requires project_id as \$1}"
  local session_id="${2:?gc_write_rejected_event requires session_id as \$2}"
  local content="${3:-}"
  local error_reason="${4:?gc_write_rejected_event requires error_reason as \$4}"

  # Sanitize session_id using the same method as paths.sh
  local sanitized
  sanitized="$(_gc_sanitize "$session_id")"

  # Build the _rejected directory path
  local rejected_dir="$GC_EVENTS_DIR/$project_id/$sanitized/_rejected"

  # Create the _rejected directory if it does not exist
  mkdir -p "$rejected_dir"

  # Generate timestamp and UUID for the filename
  local timestamp
  timestamp="$(date -u +"%Y%m%dT%H%M%S%3NZ")"

  local uuid
  if [[ -r /proc/sys/kernel/random/uuid ]]; then
    uuid="$(cat /proc/sys/kernel/random/uuid)"
  elif command -v uuidgen &>/dev/null; then
    uuid="$(uuidgen | tr '[:upper:]' '[:lower:]')"
  else
    # Fallback: generate a pseudo-random hex string
    uuid="$(printf '%04x%04x-%04x-%04x-%04x-%04x%04x%04x' \
      $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM)"
  fi

  local filename="${timestamp}-${uuid}.json"
  local target_path="$rejected_dir/$filename"

  # Generate ISO 8601 timestamp for the JSON payload
  local iso_timestamp
  iso_timestamp="$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")"

  # Truncate content preview if excessively long (>10KB)
  local max_preview=10240
  local original_content="$content"
  if [[ ${#original_content} -gt $max_preview ]]; then
    original_content="${original_content:0:$max_preview}... [truncated, original length: ${#content}]"
  fi

  # Escape JSON special characters in content and reason
  # Using python3 for reliable JSON encoding, with jq fallback
  local json_payload
  if command -v jq &>/dev/null; then
    json_payload="$(jq -n \
      --arg rejected_at "$iso_timestamp" \
      --arg reason "$error_reason" \
      --arg original "$original_content" \
      '{
        "_rejected_at": $rejected_at,
        "_reason": $reason,
        "_original_content": $original
      }')"
  elif command -v python3 &>/dev/null; then
    json_payload="$(python3 -c "
import json, sys
print(json.dumps({
    '_rejected_at': sys.argv[1],
    '_reason': sys.argv[2],
    '_original_content': sys.argv[3]
}, indent=2))
" "$iso_timestamp" "$error_reason" "$original_content")"
  else
    # Manual JSON escaping as last resort (handles basic cases)
    local esc_reason="${error_reason//\\/\\\\}"
    esc_reason="${esc_reason//\"/\\\"}"
    local esc_content="${original_content//\\/\\\\}"
    esc_content="${esc_content//\"/\\\"}"
    json_payload="{
  \"_rejected_at\": \"$iso_timestamp\",
  \"_reason\": \"$esc_reason\",
  \"_original_content\": \"$esc_content\"
}"
  fi

  # Write atomically (no fsync needed for rejected events)
  gc_atomic_write "$target_path" "$json_payload"

  # Return the path to the written file
  printf '%s' "$target_path"
}
