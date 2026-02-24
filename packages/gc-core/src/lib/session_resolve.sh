#!/usr/bin/env bash
# session_resolve.sh -- Session resolution helpers for gc-query
# Provides: resolve_latest_session, resolve_session_id, validate_session_exists
# Part of Story 05, Task 05.
set -euo pipefail

# Source dependencies
_SESSION_RESOLVE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "${_SESSION_RESOLVE_DIR}/paths.sh"
# shellcheck source=latest_symlink.sh
source "${_SESSION_RESOLVE_DIR}/latest_symlink.sh"

# resolve_latest_session(project_id)
#
# Returns the latest session ID for a project. Strategy:
#   1. Read the per-project `latest` symlink
#   2. If missing/broken, fall back to scanning event dirs for most recently modified
# Outputs session_id to stdout. Returns 1 if no sessions found.
resolve_latest_session() {
  local project_id="${1:?resolve_latest_session: project_id required}"

  # Try the symlink first
  local symlink_target
  symlink_target="$(gc_read_latest_session_id "$project_id")"
  if [[ -n "$symlink_target" ]]; then
    # Verify the target session directory exists
    local session_dir="$GC_EVENTS_DIR/$project_id/$symlink_target"
    if [[ -d "$session_dir" ]]; then
      printf '%s' "$symlink_target"
      return 0
    fi
  fi

  # Fallback: scan for most recently modified session directory
  local project_events_dir="$GC_EVENTS_DIR/$project_id"
  if [[ ! -d "$project_events_dir" ]]; then
    echo "resolve_latest_session: no sessions found for project $project_id" >&2
    return 1
  fi

  local latest_dir=""
  local latest_mtime=0
  local d mtime
  for d in "$project_events_dir"/*/; do
    [[ -d "$d" ]] || continue
    # Use stat to get mtime
    mtime="$(stat -c '%Y' "$d" 2>/dev/null || stat -f '%m' "$d" 2>/dev/null || echo 0)"
    if [[ "$mtime" -gt "$latest_mtime" ]]; then
      latest_mtime="$mtime"
      latest_dir="$d"
    fi
  done

  if [[ -z "$latest_dir" ]]; then
    echo "resolve_latest_session: no sessions found for project $project_id" >&2
    return 1
  fi

  # Extract session_id from directory name
  local session_id
  session_id="$(basename "$latest_dir")"
  printf '%s' "$session_id"
  return 0
}

# resolve_session_id(project_id, partial_id)
#
# Resolves a partial session ID to a full session ID.
#   - Exact match: return it
#   - Single prefix match: return it
#   - Multiple matches: list them to stderr, exit with code 2
#   - No matches: error to stderr, exit with code 3
resolve_session_id() {
  local project_id="${1:?resolve_session_id: project_id required}"
  local partial_id="${2:?resolve_session_id: partial_id required}"

  local project_events_dir="$GC_EVENTS_DIR/$project_id"
  if [[ ! -d "$project_events_dir" ]]; then
    echo "error: no sessions found for project $project_id" >&2
    return 3
  fi

  # Check exact match first
  if [[ -d "$project_events_dir/$partial_id" ]]; then
    printf '%s' "$partial_id"
    return 0
  fi

  # Prefix search
  local matches=()
  local d name
  for d in "$project_events_dir"/*/; do
    [[ -d "$d" ]] || continue
    name="$(basename "$d")"
    if [[ "$name" == "$partial_id"* ]]; then
      matches+=("$name")
    fi
  done

  if [[ ${#matches[@]} -eq 0 ]]; then
    echo "error: no session matching '$partial_id' found" >&2
    return 3
  elif [[ ${#matches[@]} -eq 1 ]]; then
    printf '%s' "${matches[0]}"
    return 0
  else
    echo "error: ambiguous session ID '$partial_id'. Matches:" >&2
    for m in "${matches[@]}"; do
      echo "  $m" >&2
    done
    return 2
  fi
}

# validate_session_exists(project_id, session_id)
#
# Checks that the session directory exists and contains at least one event file.
# Returns 0 if valid, 1 if not.
validate_session_exists() {
  local project_id="${1:?validate_session_exists: project_id required}"
  local session_id="${2:?validate_session_exists: session_id required}"

  local session_dir="$GC_EVENTS_DIR/$project_id/$session_id"
  if [[ ! -d "$session_dir" ]]; then
    return 1
  fi

  # Check for at least one [0-9]*.json event file
  local f
  for f in "$session_dir"/[0-9]*.json; do
    if [[ -f "$f" ]]; then
      return 0
    fi
  done

  return 1
}
