#!/usr/bin/env bash
# session_dir.sh -- Session directory creation and lock file management.
# Creates per-session directories under events/ on demand.
# Each directory contains event files and a .lock file for flock coordination.
#
# Resolves review issue C-1: canonical lock file is .lock (not _seq.lock).
# Amendment 1: No global .sessions.lock -- all locking is per-session only.
set -euo pipefail

# Source dependencies
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/paths.sh"
source "$SCRIPT_DIR/sanitize.sh"

# gc_ensure_session_dir(project_id, session_id)
#   1. Sanitize the session ID using gc_sanitize_session_id.
#   2. Compute path: $GC_EVENTS_DIR/{project_id}/{sanitized_id}/
#   3. Create directory: mkdir -p "$dir"
#   4. Create lock file: touch "$dir/.lock" (idempotent)
#   5. Return the directory path on stdout.
#
# Safe under concurrent invocation: mkdir -p is inherently safe, touch is idempotent.
gc_ensure_session_dir() {
  local project_id="${1:?gc_ensure_session_dir requires project_id as \$1}"
  local session_id="${2-}"

  # Step 1: sanitize
  local sanitized
  sanitized="$(gc_sanitize_session_id "$session_id")"

  # Step 2: compute path
  local dir="$GC_EVENTS_DIR/$project_id/$sanitized"

  # Step 3: create directory
  mkdir -p "$dir"

  # Step 4: create lock file (idempotent)
  touch "$dir/.lock"

  # Step 5: return directory path
  printf '%s' "$dir"
}
