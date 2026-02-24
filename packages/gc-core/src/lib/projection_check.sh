#!/usr/bin/env bash
# projection_check.sh -- Projection staleness check using _last_sequence
# Returns 0 (current) if projection is up-to-date, 1 (stale) if not.
# Part of Story 05, Task 04. Wraps gc_is_projection_stale from projection_store.sh
# with inverted semantics for readability in gc-query.
set -euo pipefail

# Source dependencies
_PROJECTION_CHECK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "${_PROJECTION_CHECK_DIR}/paths.sh"

# is_projection_current(project_id, session_id, projection_name)
# Returns 0 (true) if projection is current, 1 (false) if stale or missing.
is_projection_current() {
  local project_id="$1"
  local session_id="$2"
  local projection_name="${3:-context}"

  local proj_file="$GC_PROJECTIONS_DIR/$project_id/$session_id/${projection_name}.json"

  # If projection file does not exist, it is stale
  [[ -f "$proj_file" ]] || return 1

  # Read _last_sequence from projection
  local proj_seq
  proj_seq="$(jq -r '._last_sequence // 0' "$proj_file" 2>/dev/null)" || return 1
  [[ "$proj_seq" != "null" && "$proj_seq" != "0" ]] || return 1

  # Find highest sequence number in events directory
  local events_dir="$GC_EVENTS_DIR/$project_id/$session_id"
  [[ -d "$events_dir" ]] || return 1

  local highest_event=0
  local f base num
  for f in "$events_dir"/[0-9]*.json; do
    [[ -f "$f" ]] || continue
    base="$(basename "$f" .json)"
    num=$((10#$base))
    if (( num > highest_event )); then
      highest_event=$num
    fi
  done

  [[ "$highest_event" -gt 0 ]] || return 1

  # Projection is current if _last_sequence >= highest event sequence
  [[ "$proj_seq" -ge "$highest_event" ]]
}
