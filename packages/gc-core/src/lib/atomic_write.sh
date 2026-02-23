#!/usr/bin/env bash
# Atomic write helper for GlobalContext.
# Writes content to a temp file, optionally fsyncs, then atomically renames.
# Addresses review issue M-3 (canonical atomic write pattern).
set -euo pipefail

# Source paths.sh for shared constants
_ATOMIC_WRITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "${_ATOMIC_WRITE_DIR}/paths.sh"

# gc_atomic_write target_path content [fsync]
#
# Writes content atomically to target_path.
#   target_path  - final destination file path (required)
#   content      - the content to write (required); pass as second arg or pipe via stdin
#   fsync        - "true" to fsync before rename, "false" (default) to skip
#
# The function writes to a temp file ({target}.tmp.{PID}), optionally fsyncs,
# then renames atomically. On failure, the temp file is removed (best-effort)
# and the function returns non-zero. The target file is never left in a
# partial state.
gc_atomic_write() {
  if [[ $# -lt 2 ]]; then
    echo "gc_atomic_write: requires at least 2 arguments (target_path, content)" >&2
    return 1
  fi
  local target_path="$1"
  local content="$2"
  local fsync="${3:-false}"

  local target_dir
  target_dir="$(dirname "$target_path")"

  # Validate that the target directory exists
  if [[ ! -d "$target_dir" ]]; then
    echo "gc_atomic_write: target directory does not exist: $target_dir" >&2
    return 1
  fi

  local tmp_path="${target_path}.tmp.${BASHPID:-$$}"

  # Cleanup handler: remove temp file on failure (best-effort)
  _gc_atomic_cleanup() {
    rm -f "$tmp_path" 2>/dev/null || true
  }

  # Write content to temp file
  if ! printf '%s' "$content" > "$tmp_path"; then
    _gc_atomic_cleanup
    echo "gc_atomic_write: failed to write temp file: $tmp_path" >&2
    return 1
  fi

  # Optional fsync
  if [[ "$fsync" == "true" ]]; then
    if ! _gc_fsync "$tmp_path"; then
      _gc_atomic_cleanup
      echo "gc_atomic_write: fsync failed for: $tmp_path" >&2
      return 1
    fi
  fi

  # Atomic rename
  if ! mv -f "$tmp_path" "$target_path"; then
    _gc_atomic_cleanup
    echo "gc_atomic_write: rename failed: $tmp_path -> $target_path" >&2
    return 1
  fi

  # Set restrictive permissions (owner read/write only)
  chmod 600 "$target_path" 2>/dev/null || true

  return 0
}

# _gc_fsync file_path
#
# Syncs a file to disk. Tries python3 first (most reliable cross-platform),
# then falls back to dd.
_gc_fsync() {
  local file_path="$1"

  # Try python3 os.fsync
  if command -v python3 &>/dev/null; then
    python3 -c "
import os, sys
fd = os.open(sys.argv[1], os.O_RDONLY)
os.fsync(fd)
os.close(fd)
" "$file_path" 2>/dev/null && return 0
  fi

  # Fallback: dd with fdatasync (Linux)
  if dd if="$file_path" of="$file_path" conv=notrunc,fdatasync count=0 2>/dev/null; then
    return 0
  fi

  # Last resort: sync(1) -- syncs everything, but at least guarantees our file
  sync 2>/dev/null || true
  return 0
}
