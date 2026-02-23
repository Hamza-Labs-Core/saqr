#!/usr/bin/env bash
set -euo pipefail

# Test Task 08: Event Envelope Construction

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

UUID_REGEX='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

export CLAUDE_CONTEXT_PATH="$TEST_DIR/store"
mkdir -p "$TEST_DIR/store/events"

# Helper: get project_id for current working directory
project_id_base=$(basename "$PWD" | tr -cd 'a-zA-Z0-9_-')
hash=$(printf '%s' "$PWD" | sha256sum | cut -c1-6)
full_pid="${project_id_base}-${hash}"

echo "=== Task 08: Envelope Construction Tests ==="

# Test 1: Valid JSON produces envelope with all 7 fields
echo ""
echo "--- Test 1: All 7 fields present ---"
echo '{"session_id":"env-test","tool_name":"Read"}' | bash "$CAPTURE_EVENT" ToolCallCompleted 2>/dev/null
event_file="$TEST_DIR/store/events/$full_pid/env-test/000001.json"

if [ -f "$event_file" ]; then
  for field in event_id event_type project_id session_id sequence timestamp data; do
    val=$(jq -r ".$field // \"__MISSING__\"" "$event_file")
    if [ "$val" != "__MISSING__" ]; then
      echo "  PASS: field '$field' present"; _record_pass
    else
      echo "  FAIL: field '$field' missing"; _record_fail
    fi
  done
else
  echo "  FAIL: event file not created"; _record_fail
fi

# Test 2: data contains original payload
echo ""
echo "--- Test 2: Data preserves original payload ---"
tool_name=$(jq -r '.data.tool_name' "$event_file" 2>/dev/null)
assert_eq "data.tool_name preserved" "Read" "$tool_name"
data_session_id=$(jq -r '.data.session_id' "$event_file" 2>/dev/null)
assert_eq "data.session_id preserved" "env-test" "$data_session_id"

# Test 3: event_type matches argument
echo ""
echo "--- Test 3: event_type matches argument ---"
etype=$(jq -r '.event_type' "$event_file" 2>/dev/null)
assert_eq "event_type is ToolCallCompleted" "ToolCallCompleted" "$etype"

# Test 4: event_id is a valid UUID
echo ""
echo "--- Test 4: event_id is UUID ---"
eid=$(jq -r '.event_id' "$event_file" 2>/dev/null)
if [[ "$eid" =~ $UUID_REGEX ]]; then
  echo "  PASS: event_id is valid UUID ($eid)"; _record_pass
else
  echo "  FAIL: event_id not a valid UUID: $eid"; _record_fail
fi

# Test 5: sequence is an integer
echo ""
echo "--- Test 5: sequence is integer ---"
seq_type=$(jq -r '.sequence | type' "$event_file" 2>/dev/null)
assert_eq "sequence is number type" "number" "$seq_type"

# Test 6: timestamp is ISO 8601 UTC
echo ""
echo "--- Test 6: timestamp is ISO 8601 ---"
ts=$(jq -r '.timestamp' "$event_file" 2>/dev/null)
if [[ "$ts" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2} ]] && [[ "$ts" == *"Z" ]]; then
  echo "  PASS: timestamp is ISO 8601 UTC ($ts)"; _record_pass
else
  echo "  FAIL: timestamp not ISO 8601: $ts"; _record_fail
fi

# Test 7: Malformed JSON still produces valid envelope
echo ""
echo "--- Test 7: Malformed JSON input ---"
export CLAUDE_CONTEXT_PATH="$TEST_DIR/store2"
mkdir -p "$TEST_DIR/store2/events"
echo 'not valid json at all' | bash "$CAPTURE_EVENT" ToolCallCompleted 2>/dev/null

# Find the session dir (session_id defaults to "unknown" for malformed JSON)
session_dir2="$TEST_DIR/store2/events/$full_pid/unknown"
if [ -d "$session_dir2" ]; then
  event_file2=$(ls "$session_dir2"/[0-9]*.json 2>/dev/null | head -1)
  if [ -n "$event_file2" ] && jq empty "$event_file2" 2>/dev/null; then
    echo "  PASS: malformed JSON still produces valid envelope"; _record_pass
    data_val=$(jq -r '.data' "$event_file2" 2>/dev/null)
    if [ "$data_val" = "not valid json at all" ]; then
      echo "  PASS: raw text stored as data string"; _record_pass
    else
      echo "  FAIL: data should be raw text string, got: $data_val"; _record_fail
    fi
  else
    echo "  FAIL: no valid event file for malformed input"; _record_fail
  fi
else
  echo "  FAIL: session dir not created for malformed input"; _record_fail
fi

# Test 8: JSON without session_id defaults to "unknown"
echo ""
echo "--- Test 8: Missing session_id defaults to unknown ---"
export CLAUDE_CONTEXT_PATH="$TEST_DIR/store3"
mkdir -p "$TEST_DIR/store3/events"
echo '{"tool_name":"Write"}' | bash "$CAPTURE_EVENT" ToolCallCompleted 2>/dev/null
session_dir3="$TEST_DIR/store3/events/$full_pid/unknown"
if [ -d "$session_dir3" ]; then
  event_file3=$(ls "$session_dir3"/[0-9]*.json 2>/dev/null | head -1)
  if [ -n "$event_file3" ]; then
    sid=$(jq -r '.session_id' "$event_file3" 2>/dev/null)
    assert_eq "session_id defaults to unknown" "unknown" "$sid"
  else
    echo "  FAIL: no event file"; _record_fail
  fi
else
  echo "  FAIL: unknown session dir not created"; _record_fail
fi

# Test 9: Compact JSON (single line)
echo ""
echo "--- Test 9: Compact JSON output ---"
line_count=$(wc -l < "$event_file")
assert_eq "output is single line (compact)" "1" "$line_count"

# Test 10: project_id field present
echo ""
echo "--- Test 10: project_id field ---"
pid_val=$(jq -r '.project_id' "$event_file" 2>/dev/null)
assert_eq "project_id matches derived value" "$full_pid" "$pid_val"

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
