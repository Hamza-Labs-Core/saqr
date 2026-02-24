#!/usr/bin/env bash
set -euo pipefail

# Test Task 09: Main Script Assembly + Task 10: Error Handling and Safety

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

# Helper: derive project_id for current dir
project_id_base=$(basename "$PWD" | tr -cd 'a-zA-Z0-9_-')
hash=$(printf '%s' "$PWD" | sha256sum | cut -c1-6)
full_pid="${project_id_base}-${hash}"

echo "=== Task 09/10: Main Script & Error Handling Tests ==="

# Test 1: Happy path with SessionStarted
echo ""
echo "--- Test 1: Happy path ---"
export CLAUDE_CONTEXT_PATH="$TEST_DIR/s1"
mkdir -p "$TEST_DIR/s1/events"
stdout_file="$TEST_DIR/stdout1"
echo '{"session_id":"happy-path"}' | bash "$CAPTURE_EVENT" SessionStarted >"$stdout_file" 2>/dev/null
rc=$?
assert_eq "exit code is 0" "0" "$rc"
event_file="$TEST_DIR/s1/events/$full_pid/happy-path/000001.json"
if [ -f "$event_file" ]; then
  echo "  PASS: event file created at expected path"; _record_pass
else
  echo "  FAIL: event file not created"; _record_fail
fi

# Test 2: All 10 known event types
echo ""
echo "--- Test 2: All 10 event types ---"
export CLAUDE_CONTEXT_PATH="$TEST_DIR/s2"
mkdir -p "$TEST_DIR/s2/events"
for etype in SessionStarted UserPromptReceived ToolCallRequested ToolCallCompleted ToolCallFailed AgentSpawned AgentCompleted TurnCompleted CompactionTriggered SessionEnded; do
  echo "{\"session_id\":\"all-types\"}" | bash "$CAPTURE_EVENT" "$etype" 2>/dev/null
done
session_dir="$TEST_DIR/s2/events/$full_pid/all-types"
file_count=$(ls "$session_dir"/[0-9]*.json 2>/dev/null | wc -l)
assert_eq "all 10 event types produced files" "10" "$file_count"

# Test 3: Unknown event type captured with warning
echo ""
echo "--- Test 3: Unknown event type ---"
export CLAUDE_CONTEXT_PATH="$TEST_DIR/s3"
mkdir -p "$TEST_DIR/s3/events"
stderr_out=$(echo '{"session_id":"future-test"}' | bash "$CAPTURE_EVENT" FutureEvent 2>&1 >/dev/null)
session_dir3="$TEST_DIR/s3/events/$full_pid/future-test"
if [ -d "$session_dir3" ]; then
  echo "  PASS: unknown event type still captured"; _record_pass
else
  echo "  FAIL: unknown event type not captured"; _record_fail
fi
if echo "$stderr_out" | grep -q "WARN"; then
  echo "  PASS: stderr contains warning for unknown type"; _record_pass
else
  echo "  FAIL: no warning for unknown event type"; _record_fail
fi

# Test 4: No arguments -> exit 0 with error
echo ""
echo "--- Test 4: No arguments ---"
export CLAUDE_CONTEXT_PATH="$TEST_DIR/s4"
stderr_out=$(echo '{"session_id":"no-args"}' | bash "$CAPTURE_EVENT" 2>&1 >/dev/null)
rc=$?
assert_eq "exit 0 with no arguments" "0" "$rc"
if echo "$stderr_out" | grep -q "ERROR"; then
  echo "  PASS: stderr contains error message"; _record_pass
else
  echo "  FAIL: no error for missing arguments"; _record_fail
fi

# Test 5: Empty stdin -> exit 0 with warning
echo ""
echo "--- Test 5: Empty stdin ---"
export CLAUDE_CONTEXT_PATH="$TEST_DIR/s5"
stderr_out=$(echo -n "" | bash "$CAPTURE_EVENT" SessionStarted 2>&1 >/dev/null)
rc=$?
assert_eq "exit 0 with empty stdin" "0" "$rc"
if echo "$stderr_out" | grep -q "WARN"; then
  echo "  PASS: stderr contains warning for empty stdin"; _record_pass
else
  echo "  FAIL: no warning for empty stdin"; _record_fail
fi

# Test 6: No stdout output in any case
echo ""
echo "--- Test 6: No stdout output ---"
export CLAUDE_CONTEXT_PATH="$TEST_DIR/s6"
mkdir -p "$TEST_DIR/s6/events"
stdout_file="$TEST_DIR/stdout6"
echo '{"session_id":"no-stdout"}' | bash "$CAPTURE_EVENT" SessionStarted >"$stdout_file" 2>/dev/null
stdout_size=$(wc -c < "$stdout_file")
assert_eq "stdout is empty" "0" "$stdout_size"

# Test 7: jq missing -> exit 0 with error
echo ""
echo "--- Test 7: jq missing ---"
export CLAUDE_CONTEXT_PATH="$TEST_DIR/s7"
# Create a temp bin dir without jq but with all other needed tools
FAKE_BIN="$TEST_DIR/fakebin"
mkdir -p "$FAKE_BIN"
for cmd in bash cat date tr printf sha256sum cut wc ls mv rm mkdir uuidgen flock; do
  real=$(command -v "$cmd" 2>/dev/null || true)
  [ -n "$real" ] && ln -sf "$real" "$FAKE_BIN/$cmd"
done
# Ensure jq is NOT in FAKE_BIN
rm -f "$FAKE_BIN/jq"
stderr_out=$(echo '{"session_id":"nojq"}' | PATH="$FAKE_BIN" bash "$CAPTURE_EVENT" SessionStarted 2>&1 >/dev/null)
rc=$?
assert_eq "exit 0 when jq missing" "0" "$rc"
if echo "$stderr_out" | grep -q "jq"; then
  echo "  PASS: stderr mentions jq"; _record_pass
else
  echo "  FAIL: stderr should mention jq"; _record_fail
fi

# Test 8: Malformed JSON -> exit 0, event still stored
echo ""
echo "--- Test 8: Malformed JSON -> still stored ---"
export CLAUDE_CONTEXT_PATH="$TEST_DIR/s8"
mkdir -p "$TEST_DIR/s8/events"
echo "this is not json" | bash "$CAPTURE_EVENT" ToolCallCompleted 2>/dev/null
rc=$?
assert_eq "exit 0 with malformed JSON" "0" "$rc"
session_dir8="$TEST_DIR/s8/events/$full_pid/unknown"
if [ -d "$session_dir8" ]; then
  echo "  PASS: malformed JSON event stored in unknown dir"; _record_pass
else
  echo "  FAIL: malformed JSON event not stored"; _record_fail
fi

# Test 9: CLAUDE_CONTEXT_PATH is respected throughout
echo ""
echo "--- Test 9: CLAUDE_CONTEXT_PATH respected ---"
export CLAUDE_CONTEXT_PATH="$TEST_DIR/custom-path"
mkdir -p "$TEST_DIR/custom-path/events"
echo '{"session_id":"path-test"}' | bash "$CAPTURE_EVENT" SessionStarted 2>/dev/null
if [ -d "$TEST_DIR/custom-path/events/$full_pid/path-test" ]; then
  echo "  PASS: events written to custom path"; _record_pass
else
  echo "  FAIL: events not at custom path"; _record_fail
fi

# Test 10: Run from a different working directory
echo ""
echo "--- Test 10: Different working directory ---"
export CLAUDE_CONTEXT_PATH="$TEST_DIR/diffcwd"
mkdir -p "$TEST_DIR/diffcwd/events"
# Run from /tmp
(cd /tmp && echo '{"session_id":"cwd-test"}' | bash "$CAPTURE_EVENT" SessionStarted 2>/dev/null)
# The project_id will be derived from /tmp
tmp_pid_base=$(basename "/tmp" | tr -cd 'a-zA-Z0-9_-')
tmp_hash=$(printf '%s' "/tmp" | sha256sum | cut -c1-6)
tmp_full_pid="${tmp_pid_base}-${tmp_hash}"
if [ -d "$TEST_DIR/diffcwd/events/$tmp_full_pid/cwd-test" ]; then
  echo "  PASS: works from different cwd (/tmp)"; _record_pass
else
  echo "  FAIL: event not written from /tmp"; _record_fail
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
