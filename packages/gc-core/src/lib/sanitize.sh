#!/usr/bin/env bash
# Session ID sanitization -- single authoritative implementation.
# All stories must call this function, never re-implement the rules.
#
# Rules:
#   1. Allowed characters: a-z A-Z 0-9 - _
#   2. Everything else is stripped (using tr -cd).
#   3. Dots are stripped by the character class, preventing path traversal.
#   4. If the result is empty, fall back to "unknown-{uuid}".
#   5. Truncate to 255 characters after sanitization.
#   6. The mapping is deterministic (except for the empty-input fallback).
set -euo pipefail

# _gc_sanitize_generate_uuid()
#   UUID v4 generator for sanitize fallback. Tries /proc, then uuidgen, then pseudo-random.
_gc_sanitize_generate_uuid() {
  if [[ -r /proc/sys/kernel/random/uuid ]]; then
    cat /proc/sys/kernel/random/uuid
  elif command -v uuidgen &>/dev/null; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  else
    # Fallback: pseudo-random UUID v4 (RFC 4122 compliant)
    printf '%04x%04x-%04x-%04x-%04x-%04x%04x%04x' \
      $RANDOM $RANDOM \
      $RANDOM \
      $(( (RANDOM & 0x0FFF) | 0x4000 )) \
      $(( (RANDOM & 0x3FFF) | 0x8000 )) \
      $RANDOM $RANDOM $RANDOM
  fi
}

gc_sanitize_session_id() {
  local raw_id="${1:-}"
  local sanitized

  # Strip all characters not in the allowed set
  sanitized="$(printf '%s' "$raw_id" | tr -cd 'a-zA-Z0-9_-')"

  # Fall back to "unknown-{uuid}" if empty
  if [[ -z "$sanitized" ]]; then
    sanitized="unknown-$(_gc_sanitize_generate_uuid)"
  fi

  # Truncate to 255 characters
  sanitized="${sanitized:0:255}"

  printf '%s' "$sanitized"
}
