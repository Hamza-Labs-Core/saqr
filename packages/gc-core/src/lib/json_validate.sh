#!/usr/bin/env bash
# JSON validation helpers for GlobalContext event store.
# Provides gc_validate_json (simple) and gc_validate_event_json (full event validation).
set -euo pipefail

# gc_validate_json(json_string) -> 0 (valid) or 1 (invalid)
# Checks whether the given string is valid JSON.
gc_validate_json() {
  local json_string="${1:-}"

  if [ -z "$json_string" ]; then
    echo "gc_validate_json: empty input" >&2
    return 1
  fi

  if ! echo "$json_string" | jq empty 2>/dev/null; then
    echo "gc_validate_json: malformed JSON" >&2
    return 1
  fi

  return 0
}

# gc_validate_event_json(json_string) -> 0 (valid) or 1 (invalid)
# Validates that the string is well-formed JSON and contains all required
# event fields with correct types.
#
# Required fields: event_id, event_type, project_id, session_id, sequence,
#                  timestamp, data
#
# Additional checks:
#   - sequence must be a positive integer
#   - timestamp must be a non-empty string
#   - data must be an object (not null, not a string, not an array, etc.)
#
# On failure, prints the error reason to stderr and returns 1.
gc_validate_event_json() {
  local json_string="${1:-}"

  # Step 1: Parse JSON using jq empty
  if [ -z "$json_string" ]; then
    echo "gc_validate_event_json: empty input" >&2
    return 1
  fi

  if ! echo "$json_string" | jq empty 2>/dev/null; then
    echo "gc_validate_event_json: malformed JSON" >&2
    return 1
  fi

  # Step 2: Check required fields exist (are not null)
  local required_fields=("event_id" "event_type" "project_id" "session_id" "sequence" "timestamp" "data")
  for field in "${required_fields[@]}"; do
    local val
    val=$(echo "$json_string" | jq -r ".$field // \"__MISSING__\"")
    if [ "$val" = "__MISSING__" ]; then
      echo "gc_validate_event_json: missing required field '$field'" >&2
      return 1
    fi
  done

  # Step 3: Verify sequence is a positive integer
  local seq_type
  seq_type=$(echo "$json_string" | jq -r '.sequence | type')
  if [ "$seq_type" != "number" ]; then
    echo "gc_validate_event_json: 'sequence' must be a positive integer, got $seq_type" >&2
    return 1
  fi

  local seq_val
  seq_val=$(echo "$json_string" | jq -r '.sequence')
  # Check it is an integer (no decimal part) and positive
  if ! echo "$seq_val" | grep -qE '^[0-9]+$'; then
    echo "gc_validate_event_json: 'sequence' must be a positive integer, got '$seq_val'" >&2
    return 1
  fi
  if [ "$seq_val" -le 0 ] 2>/dev/null; then
    echo "gc_validate_event_json: 'sequence' must be a positive integer, got '$seq_val'" >&2
    return 1
  fi

  # Step 4: Verify timestamp is a non-empty string
  local ts_type
  ts_type=$(echo "$json_string" | jq -r '.timestamp | type')
  if [ "$ts_type" != "string" ]; then
    echo "gc_validate_event_json: 'timestamp' must be a non-empty string, got $ts_type" >&2
    return 1
  fi
  local ts_val
  ts_val=$(echo "$json_string" | jq -r '.timestamp')
  if [ -z "$ts_val" ]; then
    echo "gc_validate_event_json: 'timestamp' must be a non-empty string" >&2
    return 1
  fi

  # Step 5: Verify data is an object or string (not null, not an array, not a number, etc.)
  # String is allowed for malformed JSON input that gets stored as raw text.
  local data_type
  data_type=$(echo "$json_string" | jq -r '.data | type')
  if [ "$data_type" != "object" ] && [ "$data_type" != "string" ]; then
    echo "gc_validate_event_json: 'data' must be an object or string, got $data_type" >&2
    return 1
  fi

  return 0
}
