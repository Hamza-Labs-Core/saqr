#!/usr/bin/env bash
# latest_symlink.sh -- Atomic symlink update for per-project latest session
# Part of GlobalContext storage layer (Task 03/10)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "$SCRIPT_DIR/paths.sh"

GC_PROJECTIONS_DIR="${GC_PROJECTIONS_DIR:-$GC_ROOT/projections}"

# gc_update_latest_symlink(project_id, session_id)
#
# Atomically update the "latest" symlink at projections/{project_id}/latest
# to point to session_id (a relative path).
#
# On Linux: uses mv -fT for atomic rename.
# On macOS: uses ln -sfn which atomically replaces the symlink.
#
# On failure: logs a warning to stderr but does not exit (non-blocking).
gc_update_latest_symlink() {
  local project_id="${1:?gc_update_latest_symlink: project_id required}"
  local session_id="${2:?gc_update_latest_symlink: session_id required}"

  local proj_dir="$GC_PROJECTIONS_DIR/$project_id"
  local symlink_path="$proj_dir/latest"
  local tmp_symlink="$proj_dir/.latest.tmp.$$"

  # Ensure project projection directory exists
  if ! mkdir -p "$proj_dir" 2>/dev/null; then
    echo "gc_update_latest_symlink: WARNING: cannot create $proj_dir" >&2
    return 0
  fi

  # Detect platform and perform atomic symlink update
  local platform
  platform="$(uname -s)"

  if [[ "$platform" == "Darwin" ]]; then
    # macOS: ln -sfn atomically replaces the symlink
    if ! ln -sfn "$session_id" "$symlink_path" 2>/dev/null; then
      echo "gc_update_latest_symlink: WARNING: failed to update symlink at $symlink_path" >&2
    fi
  else
    # Linux: create temp symlink, then mv -fT for atomic rename
    if ! ln -s "$session_id" "$tmp_symlink" 2>/dev/null; then
      echo "gc_update_latest_symlink: WARNING: failed to create temp symlink at $tmp_symlink" >&2
      return 0
    fi
    if ! mv -fT "$tmp_symlink" "$symlink_path" 2>/dev/null; then
      echo "gc_update_latest_symlink: WARNING: failed to atomically rename symlink at $symlink_path" >&2
      rm -f "$tmp_symlink" 2>/dev/null || true
    fi
  fi

  return 0
}

# gc_read_latest_session_id(project_id) -> session_id
#
# Reads the target of the "latest" symlink for a project.
# Returns the session ID (the symlink target) on stdout.
# If symlink does not exist, returns empty string (no output).
gc_read_latest_session_id() {
  local project_id="${1:?gc_read_latest_session_id: project_id required}"

  local symlink_path="$GC_PROJECTIONS_DIR/$project_id/latest"

  if [[ -L "$symlink_path" ]]; then
    readlink "$symlink_path"
  fi

  return 0
}
