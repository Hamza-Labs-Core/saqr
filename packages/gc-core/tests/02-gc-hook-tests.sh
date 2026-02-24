#!/usr/bin/env bash
set -euo pipefail

# 02-gc-hook-tests.sh -- Unit tests for src/gc-hook
# Exit 0 on success, non-zero on failure.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GC_HOOK="$PROJECT_ROOT/src/gc-hook"

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

# Helper to set up a temp GC_BASE with mock capture-event
setup_gc_base() {
  local base="$TMPDIR_BASE/gc-base-$$-$RANDOM"
  mkdir -p "$base/bin"
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
echo "=== T-1: gc-hook exits 0 when capture-event is missing ==="
# ===================================================================
(
  base=$(setup_gc_base)
  # No capture-event created
  exit_code=0
  echo '{"session_id":"test"}' | CLAUDE_CONTEXT_PATH="$base" "$GC_HOOK" SessionStarted || exit_code=$?
  assert_eq "exit code is 0 when capture-event missing" "0" "$exit_code"
)

# ===================================================================
echo ""
echo "=== T-2: gc-hook exits 0 when capture-event crashes (exit 1) ==="
# ===================================================================
(
  base=$(setup_gc_base)
  create_mock_capture_event "$base" "exit 1"
  exit_code=0
  echo '{"session_id":"test"}' | CLAUDE_CONTEXT_PATH="$base" "$GC_HOOK" SessionStarted || exit_code=$?
  assert_eq "exit code is 0 when capture-event crashes" "0" "$exit_code"
)

# ===================================================================
echo ""
echo "=== T-3: gc-hook produces zero bytes on stdout ==="
# ===================================================================
(
  base=$(setup_gc_base)
  create_mock_capture_event "$base" 'echo "I should not appear"'
  stdout_output=$(echo '{"session_id":"test"}' | CLAUDE_CONTEXT_PATH="$base" "$GC_HOOK" SessionStarted)
  assert_eq "stdout is empty" "" "$stdout_output"
)

# ===================================================================
echo ""
echo "=== T-4: gc-hook produces zero bytes on stderr ==="
# ===================================================================
(
  base=$(setup_gc_base)
  create_mock_capture_event "$base" 'echo "error!" >&2'
  stderr_file="$TMPDIR_BASE/stderr-$$"
  echo '{"session_id":"test"}' | CLAUDE_CONTEXT_PATH="$base" "$GC_HOOK" SessionStarted 2>"$stderr_file"
  stderr_content=$(cat "$stderr_file")
  assert_eq "stderr is empty" "" "$stderr_content"
)

# ===================================================================
echo ""
echo "=== T-5: gc-hook passes stdin through to capture-event ==="
# ===================================================================
(
  base=$(setup_gc_base)
  stdin_capture="$TMPDIR_BASE/stdin-capture-$$"
  create_mock_capture_event "$base" "cat > '$stdin_capture'"
  input_json='{"session_id":"test-pass-through","data":"hello"}'
  echo "$input_json" | CLAUDE_CONTEXT_PATH="$base" "$GC_HOOK" SessionStarted
  captured=$(cat "$stdin_capture")
  assert_eq "stdin passed through to capture-event" "$input_json" "$captured"
)

# ===================================================================
echo ""
echo "=== T-6: gc-hook passes event type as \$1 to capture-event ==="
# ===================================================================
(
  base=$(setup_gc_base)
  arg_capture="$TMPDIR_BASE/arg-capture-$$"
  create_mock_capture_event "$base" "echo \"\$1\" > '$arg_capture'"
  echo '{"session_id":"test"}' | CLAUDE_CONTEXT_PATH="$base" "$GC_HOOK" ToolCallRequested
  captured=$(cat "$arg_capture")
  assert_eq "event type passed as \$1" "ToolCallRequested" "$captured"
)

# ===================================================================
echo ""
echo "=== T-7: gc-hook respects CLAUDE_CONTEXT_PATH env var ==="
# ===================================================================
(
  base=$(setup_gc_base)
  marker="$TMPDIR_BASE/marker-$$"
  create_mock_capture_event "$base" "touch '$marker'"

  # Also create a mock at a different path to ensure it's not called
  other_base=$(setup_gc_base)
  other_marker="$TMPDIR_BASE/other-marker-$$"
  create_mock_capture_event "$other_base" "touch '$other_marker'"

  echo '{"session_id":"test"}' | CLAUDE_CONTEXT_PATH="$base" "$GC_HOOK" SessionStarted
  if [ -f "$marker" ]; then
    echo "  PASS: correct capture-event invoked via CLAUDE_CONTEXT_PATH"
    _record_pass
  else
    echo "  FAIL: capture-event at CLAUDE_CONTEXT_PATH was not invoked"
    _record_fail
  fi
  if [ ! -f "$other_marker" ]; then
    echo "  PASS: other capture-event was not invoked"
    _record_pass
  else
    echo "  FAIL: other capture-event was unexpectedly invoked"
    _record_fail
  fi
)

# ===================================================================
echo ""
echo "=== T-8: gc-hook handles large payloads (1MB) without truncation ==="
# ===================================================================
(
  base=$(setup_gc_base)
  stdin_capture="$TMPDIR_BASE/large-stdin-$$"
  create_mock_capture_event "$base" "cat > '$stdin_capture'"

  # Generate ~1MB JSON payload
  large_payload=$(python3 -c "
import json, sys
data = {'session_id': 'large-test', 'payload': 'x' * (1024 * 1024)}
json.dump(data, sys.stdout)
" 2>/dev/null || {
    # Fallback if python3 is not available: use dd
    printf '{"session_id":"large-test","payload":"'
    dd if=/dev/zero bs=1024 count=1024 2>/dev/null | tr '\0' 'x'
    printf '"}'
  })

  input_size=${#large_payload}
  echo "$large_payload" | CLAUDE_CONTEXT_PATH="$base" "$GC_HOOK" SessionStarted

  if [ -f "$stdin_capture" ]; then
    captured_size=$(wc -c < "$stdin_capture")
    # Account for the trailing newline from echo
    expected_size=$((input_size + 1))
    if [ "$captured_size" -eq "$expected_size" ]; then
      echo "  PASS: large payload (${input_size} bytes) passed through without truncation"
      _record_pass
    else
      echo "  FAIL: payload size mismatch (expected $expected_size, got $captured_size)"
      _record_fail
    fi
  else
    echo "  FAIL: stdin capture file not created"
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
