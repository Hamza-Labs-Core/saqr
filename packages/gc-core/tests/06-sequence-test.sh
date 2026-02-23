#!/usr/bin/env bash
set -euo pipefail

# Test Task 06: Sequence Numbering with flock

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

export CLAUDE_CONTEXT_PATH="$TEST_DIR/store"
mkdir -p "$TEST_DIR/store/events"

echo "=== Task 06: Sequence Numbering Tests ==="

# Test 1: 5 sequential events produce 000001-000005
echo ""
echo "--- Test 1: Sequential numbering ---"
for i in $(seq 1 5); do
  echo '{"session_id":"seq-test-1"}' | bash "$CAPTURE_EVENT" SessionStarted 2>/dev/null
done

# Find the session directory
project_id=$(basename "$PWD" | tr -cd 'a-zA-Z0-9_-')
hash=$(printf '%s' "$PWD" | sha256sum | cut -c1-6)
full_pid="${project_id}-${hash}"
session_dir="$TEST_DIR/store/events/$full_pid/seq-test-1"

for i in $(seq 1 5); do
  padded=$(printf "%06d" "$i")
  if [ -f "$session_dir/${padded}.json" ]; then
    echo "  PASS: ${padded}.json exists"; _record_pass
  else
    echo "  FAIL: ${padded}.json missing"; _record_fail
  fi
done

# Test 2: Verify sequence field matches filename
echo ""
echo "--- Test 2: Sequence field matches filename ---"
for i in $(seq 1 5); do
  padded=$(printf "%06d" "$i")
  seq_val=$(jq -r '.sequence' "$session_dir/${padded}.json" 2>/dev/null)
  assert_eq "sequence in ${padded}.json" "$i" "$seq_val"
done

# Test 3: 10 concurrent events -- all unique sequences
echo ""
echo "--- Test 3: Concurrent writes ---"
export CLAUDE_CONTEXT_PATH="$TEST_DIR/store2"
mkdir -p "$TEST_DIR/store2/events"

for i in $(seq 1 10); do
  echo '{"session_id":"conc-test"}' | bash "$CAPTURE_EVENT" ToolCallCompleted 2>/dev/null &
done
wait

session_dir2="$TEST_DIR/store2/events/$full_pid/conc-test"
file_count=$(ls "$session_dir2"/[0-9]*.json 2>/dev/null | wc -l)
assert_eq "10 concurrent events all written" "10" "$file_count"

# Check no duplicate sequence numbers
sequences=$(for f in "$session_dir2"/[0-9]*.json; do jq -r '.sequence' "$f"; done | sort -n)
unique_count=$(echo "$sequences" | sort -u | wc -l)
assert_eq "all sequences unique" "10" "$unique_count"

# Test 4: Lock file location
echo ""
echo "--- Test 4: Lock file at .lock ---"
if [ -f "$session_dir/.lock" ]; then
  echo "  PASS: lock file at .lock"; _record_pass
else
  echo "  FAIL: lock file missing at .lock"; _record_fail
fi

# Verify NOT at _seq.lock
if [ ! -f "$session_dir/_seq.lock" ]; then
  echo "  PASS: no _seq.lock file"; _record_pass
else
  echo "  FAIL: _seq.lock should not exist"; _record_fail
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
