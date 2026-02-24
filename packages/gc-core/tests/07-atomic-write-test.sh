#!/usr/bin/env bash
set -euo pipefail

# Test Task 07: Atomic Write Helper

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CAPTURE_EVENT="$PROJECT_ROOT/src/capture-event"

RESULT_FILE=$(mktemp)
echo "0 0" > "$RESULT_FILE"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"; rm -f "$RESULT_FILE"' EXIT

_record_pass() {
  local counts; counts=$(cat "$RESULT_FILE")
  local p f; p=$(echo "$counts" | cut -d' ' -f1); f=$(echo "$counts" | cut -d' ' -f2)
  echo "$((p + 1)) $f" > "$RESULT_FILE"
}
_record_fail() {
  local counts; counts=$(cat "$RESULT_FILE")
  local p f; p=$(echo "$counts" | cut -d' ' -f1); f=$(echo "$counts" | cut -d' ' -f2)
  echo "$p $((f + 1))" > "$RESULT_FILE"
}
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS: $label"; _record_pass
  else
    echo "  FAIL: $label"; echo "    expected: $expected"; echo "    actual:   $actual"; _record_fail
  fi
}

echo "=== Task 07: Atomic Write Tests ==="

# Test 1: Event file is written with correct content
echo ""
echo "--- Test 1: Correct content written ---"
export CLAUDE_CONTEXT_PATH="$TEST_DIR/store"
mkdir -p "$TEST_DIR/store/events"
echo '{"session_id":"aw-test","tool_name":"Read"}' | bash "$CAPTURE_EVENT" ToolCallCompleted 2>/dev/null

project_id=$(basename "$PWD" | tr -cd 'a-zA-Z0-9_-')
hash=$(printf '%s' "$PWD" | sha256sum | cut -c1-6)
full_pid="${project_id}-${hash}"
session_dir="$TEST_DIR/store/events/$full_pid/aw-test"
event_file="$session_dir/000001.json"

if [ -f "$event_file" ]; then
  echo "  PASS: event file exists"; _record_pass
  # Verify it's valid JSON
  if jq empty "$event_file" 2>/dev/null; then
    echo "  PASS: event file is valid JSON"; _record_pass
  else
    echo "  FAIL: event file is not valid JSON"; _record_fail
  fi
else
  echo "  FAIL: event file not created"; _record_fail
fi

# Test 2: No .tmp files remain
echo ""
echo "--- Test 2: No temp files ---"
tmp_count=$(find "$session_dir" -name '*.tmp.*' 2>/dev/null | wc -l)
assert_eq "no tmp files remain" "0" "$tmp_count"

# Test 3: Event file ends with newline
echo ""
echo "--- Test 3: File ends with newline ---"
last_char=$(tail -c 1 "$event_file" | xxd -p)
if [ "$last_char" = "0a" ]; then
  echo "  PASS: file ends with newline"; _record_pass
else
  echo "  FAIL: file does not end with newline (last byte: $last_char)"; _record_fail
fi

# Summary
echo ""
counts=$(cat "$RESULT_FILE")
PASS=$(echo "$counts" | cut -d' ' -f1)
FAIL=$(echo "$counts" | cut -d' ' -f2)
echo "=============================="
echo "Results: $PASS passed, $FAIL failed"
echo "=============================="
[ "$FAIL" -gt 0 ] && exit 1
exit 0
