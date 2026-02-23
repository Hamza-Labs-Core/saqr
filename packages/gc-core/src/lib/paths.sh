#!/usr/bin/env bash
# paths.sh -- Shared shell library for GlobalContext
# Single source of truth for storage root, directory constants, and path helpers.
# Every script in the project sources this file. No script should hardcode ~/.claude-context.

# ---------------------------------------------------------------------------
# Resolve storage root (respects CLAUDE_CONTEXT_PATH env var -- review issue M-4)
# ---------------------------------------------------------------------------
GC_ROOT="${CLAUDE_CONTEXT_PATH:-$HOME/.claude-context}"

# ---------------------------------------------------------------------------
# Directory constants -- all derived from GC_ROOT
# ---------------------------------------------------------------------------
GC_EVENTS_DIR="$GC_ROOT/events"
GC_PROJECTIONS_DIR="$GC_ROOT/projections"
GC_BIN_DIR="$GC_ROOT/bin"
GC_CONFIG_FILE="$GC_ROOT/config.json"
# Note: No global sessions.json or .sessions.lock -- per-session metadata only (Amendment 1)

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

# Sanitize a string to contain only [a-zA-Z0-9_-]
_gc_sanitize() {
  printf '%s' "$1" | tr -cd 'a-zA-Z0-9_-'
}

# Portable SHA-256: sha256sum -> shasum -> openssl fallback
_gc_sha256() {
  if command -v sha256sum &>/dev/null; then
    sha256sum
  elif command -v shasum &>/dev/null; then
    shasum -a 256
  elif command -v openssl &>/dev/null; then
    openssl dgst -sha256 -r
  else
    echo "000000000000000000000000000000000000000000000000000000000000dead  -"
  fi
}

# gc_session_events_dir(project_id, session_id)
#   Returns: $GC_EVENTS_DIR/{project_id}/{sanitized-session-id}
gc_session_events_dir() {
  local project_id="$1"
  local session_id="$2"
  local sanitized
  sanitized=$(_gc_sanitize "$session_id")
  printf '%s' "$GC_EVENTS_DIR/$project_id/$sanitized"
}

# gc_session_lock_file(project_id, session_id)
#   Returns: $GC_EVENTS_DIR/{project_id}/{sanitized-session-id}/.lock
gc_session_lock_file() {
  local project_id="$1"
  local session_id="$2"
  local sanitized
  sanitized=$(_gc_sanitize "$session_id")
  printf '%s' "$GC_EVENTS_DIR/$project_id/$sanitized/.lock"
}

# gc_session_projections_dir(project_id, session_id)
#   Returns: $GC_PROJECTIONS_DIR/{project_id}/{sanitized-session-id}
gc_session_projections_dir() {
  local project_id="$1"
  local session_id="$2"
  local sanitized
  sanitized=$(_gc_sanitize "$session_id")
  printf '%s' "$GC_PROJECTIONS_DIR/$project_id/$sanitized"
}

# gc_project_latest(project_id)
#   Returns: $GC_PROJECTIONS_DIR/{project_id}/latest
gc_project_latest() {
  local project_id="$1"
  printf '%s' "$GC_PROJECTIONS_DIR/$project_id/latest"
}

# gc_resolve_root()
#   Validates the root path exists and is initialized.
#   Prints an error to stderr and returns 1 if not initialized.
#   Returns the root path on success.
gc_resolve_root() {
  if [ ! -d "$GC_ROOT" ]; then
    echo "error: GlobalContext store not initialized at $GC_ROOT" >&2
    echo "hint: run 'gc-init' to create the store" >&2
    return 1
  fi
  printf '%s' "$GC_ROOT"
}

# gc_derive_project_id(project_dir)
#   Returns: {basename}-{hash6}
#   basename = last component of project_dir, sanitized to [a-zA-Z0-9_-]
#   hash6   = first 6 hex chars of SHA-256 of the full absolute path
#   Falls back to "_unknown-000000" if project_dir is empty.
gc_derive_project_id() {
  local project_dir="$1"
  if [ -z "$project_dir" ]; then
    printf '%s' "_unknown-000000"
    return
  fi
  local base
  base=$(basename "$project_dir" | tr -cd 'a-zA-Z0-9_-')
  [ -z "$base" ] && base="_root"
  local hash
  hash=$(printf '%s' "$project_dir" | _gc_sha256 | cut -c1-6)
  printf '%s' "${base}-${hash}"
}
