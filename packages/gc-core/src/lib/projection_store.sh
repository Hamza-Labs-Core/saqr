#!/usr/bin/env bash
# projection_store.sh -- Projection directory scaffolding for GlobalContext.
# Handles projection directory creation, metadata-wrapped writes, staleness
# detection, and reading projection files. Actual projection logic (timeline,
# files-touched, etc.) is Story 04's responsibility.
set -euo pipefail

# Source dependencies
_PROJECTION_STORE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "${_PROJECTION_STORE_DIR}/paths.sh"
# shellcheck source=atomic_write.sh
source "${_PROJECTION_STORE_DIR}/atomic_write.sh"

# gc_ensure_projection_dir(project_id, session_id)
#
# Creates $GC_PROJECTIONS_DIR/{project_id}/{session_id}/ if it does not exist.
# Returns the directory path on stdout.
gc_ensure_projection_dir() {
  local project_id="$1"
  local session_id="$2"
  local dir
  dir="$(gc_session_projections_dir "$project_id" "$session_id")"
  mkdir -p "$dir"
  printf '%s' "$dir"
}

# gc_write_projection(project_id, session_id, projection_name, data_json, event_count, last_sequence)
#
# Wraps data_json in a metadata envelope and writes atomically to the
# projection file at $GC_PROJECTIONS_DIR/{project_id}/{session_id}/{projection_name}.json
gc_write_projection() {
  local project_id="$1"
  local session_id="$2"
  local projection_name="$3"
  local data_json="$4"
  local event_count="$5"
  local last_sequence="$6"

  local dir
  dir="$(gc_ensure_projection_dir "$project_id" "$session_id")"

  local rebuilt_at
  rebuilt_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  local envelope
  envelope="$(jq -n \
    --arg projection "$projection_name" \
    --arg project_id "$project_id" \
    --arg session_id "$session_id" \
    --arg rebuilt_at "$rebuilt_at" \
    --argjson event_count "$event_count" \
    --argjson last_sequence "$last_sequence" \
    --argjson data "$data_json" \
    '{
      "_projection": $projection,
      "_project_id": $project_id,
      "_session_id": $session_id,
      "_rebuilt_at": $rebuilt_at,
      "_event_count": $event_count,
      "_last_sequence": $last_sequence,
      "data": $data
    }'
  )"

  local target_path="${dir}/${projection_name}.json"
  gc_atomic_write "$target_path" "$envelope"
}

# gc_is_projection_stale(project_id, session_id, projection_name)
#
# Checks if a projection is stale by comparing the projection's _last_sequence
# with the number of [0-9]*.json event files in the session events directory.
# Returns 0 (true/stale) if the projection is stale or missing.
# Returns 1 (false/current) if the projection is up-to-date.
gc_is_projection_stale() {
  local project_id="$1"
  local session_id="$2"
  local projection_name="$3"

  local proj_dir
  proj_dir="$(gc_session_projections_dir "$project_id" "$session_id")"
  local proj_file="${proj_dir}/${projection_name}.json"

  # If projection file does not exist, it's stale
  if [[ ! -f "$proj_file" ]]; then
    return 0
  fi

  # Read _last_sequence from the projection file
  local last_sequence
  last_sequence="$(jq -r '._last_sequence' "$proj_file" 2>/dev/null)" || return 0
  if [[ -z "$last_sequence" ]] || [[ "$last_sequence" == "null" ]]; then
    return 0
  fi

  # Count [0-9]*.json files in the events directory (excludes session.json, lock files, etc.)
  local events_dir
  events_dir="$(gc_session_events_dir "$project_id" "$session_id")"

  local event_count=0
  if [[ -d "$events_dir" ]]; then
    # Use a subshell with nullglob to count matching files
    event_count=$(
      shopt -s nullglob
      files=("${events_dir}"/[0-9]*.json)
      echo "${#files[@]}"
    )
  fi

  # If event count > last_sequence, projection is stale
  if [[ "$event_count" -gt "$last_sequence" ]]; then
    return 0
  fi

  # Projection is current
  return 1
}

# gc_read_projection(project_id, session_id, projection_name)
#
# Reads and returns the projection file content.
# Returns empty string if the file does not exist.
gc_read_projection() {
  local project_id="$1"
  local session_id="$2"
  local projection_name="$3"

  local proj_dir
  proj_dir="$(gc_session_projections_dir "$project_id" "$session_id")"
  local proj_file="${proj_dir}/${projection_name}.json"

  if [[ -f "$proj_file" ]]; then
    cat "$proj_file"
  else
    printf ''
  fi
}
