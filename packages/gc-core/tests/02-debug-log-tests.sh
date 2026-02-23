#!/usr/bin/env bash
set -euo pipefail

# 02-debug-log-tests.sh -- Tests for debug logging behavior
# Exit 0 on success, non-zero on failure.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GC_HOOK="$PROJECT_ROOT/src/gc-hook"
DEBUG_LOG_SH="$PROJECT_ROOT/src/lib/debug_log.sh"

# Track pass/fail
RESULT_FILE=$(mktemp)
echo "0 0" > "$RESULT_FILE"
TMPDIR_BASE=$(mktemp -d)
trap 'rm -f "$RESULT_FILE"; rm -rf "$TMPDIR_BASE"' EXIT

_record_pass() {
  local counts p f
  counts=$(cat "$RESULT_FILE")
  p=$(echo "$counts" | cut -d' ' -f1)
  f=$(echo "$counts" | cut -d' ' -f2)
  echo "$((p + 1)) $f" > "$RESULT_FILE"
}

_record_fail() {
  local counts p f
  counts=$(cat "$RESULT_FILE")
  p=$(echo "$counts" | cut -d' ' -f1)
  f=$(echo "$counts" | cut -d' ' -f2)
  echo "$p $((f + 1))" > "$RESULT_FILE"
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS: $label"
    _record_pass
  else
    echo "  FAIL: $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    _record_fail
  fi
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    echo "  PASS: $label"
    _record_pass
  else
    echo "  FAIL: $label"
    echo "    expected to contain: $needle"
    echo "    actual:              $haystack"
    _record_fail
  fi
}

setup_gc_base() {
  local base="$TMPDIR_BASE/gc-base-$$-$RANDOM"
  mkdir -p "$base/bin" "$base/lib"
  cp "$DEBUG_LOG_SH" "$base/lib/debug_log.sh"
  echo "$base"
}

create_mock_capture_event() {
  local base="$1"
  local script_content="$2"
  cat > "$base/bin/capture-event" <<SCRIPT
#!/usr/bin/env bash
$script_content
SCRIPT
  chmod +x "$base/bin/capture-event"
}

# ===================================================================
echo "=== T-1: No log file when GC_DEBUG is unset ==="
# ===================================================================
(
  base=$(setup_gc_base)
  create_mock_capture_event "$base" "cat > /dev/null"
  echo '{"session_id":"test"}' | CLAUDE_CONTEXT_PATH="$base" "$GC_HOOK" SessionStarted
  if [ ! -d "$base/logs" ]; then
    echo "  PASS: no logs directory created"
    _record_pass
  else
    echo "  FAIL: logs directory should not exist when GC_DEBUG unset"
    _record_fail
  fi
)

# ===================================================================
echo ""
echo "=== T-2: Log file created when GC_DEBUG=1 ==="
# ===================================================================
(
  base=$(setup_gc_base)
  create_mock_capture_event "$base" "cat > /dev/null"
  echo '{"session_id":"test"}' | GC_DEBUG=1 CLAUDE_CONTEXT_PATH="$base" "$GC_HOOK" SessionStarted
  if [ -f "$base/logs/hook.log" ]; then
    echo "  PASS: log file created"
    _record_pass
  else
    echo "  FAIL: log file not created at $base/logs/hook.log"
    _record_fail
  fi
)

# ===================================================================
echo ""
echo "=== T-3: Log entry contains timestamp and event type ==="
# ===================================================================
(
  base=$(setup_gc_base)
  create_mock_capture_event "$base" "cat > /dev/null"
  echo '{"session_id":"test"}' | GC_DEBUG=1 CLAUDE_CONTEXT_PATH="$base" "$GC_HOOK" ToolCallRequested
  if [ -f "$base/logs/hook.log" ]; then
    log_content=$(cat "$base/logs/hook.log")
    assert_contains "log has timestamp format" "$log_content" "T"
    assert_contains "log has event type" "$log_content" "ToolCallRequested"
  else
    echo "  FAIL: log file not found"
    _record_fail
  fi
)

# ===================================================================
echo ""
echo "=== T-4: Failure logged when capture-event fails with GC_DEBUG=1 ==="
# ===================================================================
(
  base=$(setup_gc_base)
  create_mock_capture_event "$base" "exit 1"
  echo '{"session_id":"test"}' | GC_DEBUG=1 CLAUDE_CONTEXT_PATH="$base" "$GC_HOOK" SessionStarted
  if [ -f "$base/logs/hook.log" ]; then
    log_content=$(cat "$base/logs/hook.log")
    assert_contains "failure logged" "$log_content" "failed"
  else
    echo "  FAIL: log file not found"
    _record_fail
  fi
)

# ===================================================================
echo ""
echo "=== T-5: Log rotation at 1MB ==="
# ===================================================================
(
  base=$(setup_gc_base)
  create_mock_capture_event "$base" "cat > /dev/null"
  mkdir -p "$base/logs"
  # Create a log file over 1MB
  dd if=/dev/zero bs=1024 count=1100 2>/dev/null | tr '\0' 'x' > "$base/logs/hook.log"
  initial_size=$(wc -c < "$base/logs/hook.log")

  echo '{"session_id":"test"}' | GC_DEBUG=1 CLAUDE_CONTEXT_PATH="$base" "$GC_HOOK" SessionStarted

  if [ -f "$base/logs/hook.log.old" ]; then
    echo "  PASS: hook.log.old created (rotation occurred)"
    _record_pass
  else
    echo "  FAIL: hook.log.old not found (rotation did not occur)"
    _record_fail
  fi

  if [ -f "$base/logs/hook.log" ]; then
    new_size=$(wc -c < "$base/logs/hook.log")
    if [ "$new_size" -lt "$initial_size" ]; then
      echo "  PASS: hook.log is smaller after rotation"
      _record_pass
    else
      echo "  FAIL: hook.log should be smaller after rotation (old: $initial_size, new: $new_size)"
      _record_fail
    fi
  else
    echo "  FAIL: hook.log should exist after rotation"
    _record_fail
  fi
)

# ===================================================================
echo ""
echo "=== T-6: GC_DEBUG=1 still exits 0, zero stdout/stderr ==="
# ===================================================================
(
  base=$(setup_gc_base)
  create_mock_capture_event "$base" "exit 1"
  stderr_file="$TMPDIR_BASE/stderr-debug-$$"
  exit_code=0
  stdout_output=$(echo '{"session_id":"test"}' | GC_DEBUG=1 CLAUDE_CONTEXT_PATH="$base" "$GC_HOOK" SessionStarted 2>"$stderr_file") || exit_code=$?
  assert_eq "exit code is 0 with GC_DEBUG=1" "0" "$exit_code"
  assert_eq "stdout is empty with GC_DEBUG=1" "" "$stdout_output"
  stderr_content=$(cat "$stderr_file")
  assert_eq "stderr is empty with GC_DEBUG=1" "" "$stderr_content"
)

# ===================================================================
echo ""
echo "=== T-7: Read-only log directory -- gc-hook still exits 0 ==="
# ===================================================================
(
  base=$(setup_gc_base)
  create_mock_capture_event "$base" "cat > /dev/null"
  mkdir -p "$base/logs"
  chmod 000 "$base/logs"
  exit_code=0
  echo '{"session_id":"test"}' | GC_DEBUG=1 CLAUDE_CONTEXT_PATH="$base" "$GC_HOOK" SessionStarted 2>/dev/null || exit_code=$?
  chmod 700 "$base/logs"  # restore for cleanup
  assert_eq "exit code is 0 with read-only log dir" "0" "$exit_code"
)

# ===================================================================
echo ""
echo "=== T-8: debug_log.sh gc_debug_log is a no-op when GC_DEBUG unset ==="
# ===================================================================
(
  base=$(setup_gc_base)
  unset GC_DEBUG 2>/dev/null || true
  GC_BASE="$base" source "$DEBUG_LOG_SH"
  gc_debug_log "this should not create a log file"
  if [ ! -d "$base/logs" ]; then
    echo "  PASS: no log dir created when GC_DEBUG unset"
    _record_pass
  else
    echo "  FAIL: log dir should not exist"
    _record_fail
  fi
)

# ===================================================================
# Summary
# ===================================================================
echo ""
counts=$(cat "$RESULT_FILE")
PASS=$(echo "$counts" | cut -d' ' -f1)
FAIL=$(echo "$counts" | cut -d' ' -f2)

echo "=============================="
echo "Results: $PASS passed, $FAIL failed"
echo "=============================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
