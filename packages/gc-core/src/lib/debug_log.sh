#!/usr/bin/env bash
# Debug logging for GlobalContext hooks
# Only active when GC_DEBUG=1
# All operations are best-effort -- logging must never break the exit-0 guarantee.

GC_LOG_DIR="${GC_BASE:-${CLAUDE_CONTEXT_PATH:-$HOME/.claude-context}}/logs"
GC_LOG_FILE="$GC_LOG_DIR/hook.log"
GC_LOG_MAX_BYTES=1048576  # 1MB

gc_debug_log() {
  [ "${GC_DEBUG:-0}" != "1" ] && return 0
  mkdir -p "$GC_LOG_DIR" 2>/dev/null || return 0

  # Rotate if over 1MB
  if [ -f "$GC_LOG_FILE" ]; then
    local size
    size=$(stat -c%s "$GC_LOG_FILE" 2>/dev/null || stat -f%z "$GC_LOG_FILE" 2>/dev/null || echo 0)
    if [ "$size" -gt "$GC_LOG_MAX_BYTES" ]; then
      mv "$GC_LOG_FILE" "$GC_LOG_FILE.old" 2>/dev/null || true
    fi
  fi

  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$GC_LOG_FILE" 2>/dev/null || true
}
