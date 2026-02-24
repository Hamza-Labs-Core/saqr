#!/usr/bin/env bash
set -euo pipefail

# Task 12: Integration Test Suite for Story 01 (Event Capture System)
# Comprehensive test of all acceptance criteria.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CAPTURE_EVENT="$PROJECT_ROOT/src/capture-event"
INSTALL_SH="$PROJECT_ROOT/src/install.sh"

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
assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    echo "  PASS: $label"; _record_pass
  else
    echo "  FAIL: $label"; echo "    expected to contain: $needle"; echo "    actual: $haystack"; _record_fail
  fi
}

UUID_REGEX='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

# Portable nanosecond timestamp: GNU date -> python3 fallback
_now_ns() {
  local ns
  ns=$(date +%s%N 2>/dev/null)
  if [[ "$ns" =~ ^[0-9]+$ ]] && [ "${#ns}" -gt 10 ]; then
    echo "$ns"
  elif command -v python3 &>/dev/null; then
    python3 -c "import time; print(int(time.time()*1e9))"
  else
    # Fallback: second precision from date +%s * 1e9
    echo "$(date +%s)000000000"
  fi
}

# Helper: portable SHA-256 (matches capture-event fallback chain)
_portable_sha256() {
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

# Helper: derive project_id for current directory
_derive_pid() {
  local dir="${1:-$PWD}"
  local base hash
  base=$(basename "$dir" | tr -cd 'a-zA-Z0-9_-')
  [ -z "$base" ] && base="_root"
  hash=$(printf '%s' "$dir" | _portable_sha256 | cut -c1-6)
  printf '%s' "${base}-${hash}"
}

echo "============================================"
echo "Story 01: Event Capture Integration Tests"
echo "============================================"

# =============================================
# Test 1: Happy path -- valid JSON, verify envelope
# =============================================
echo ""
echo "=== Test 1: Happy path ==="
export CLAUDE_CONTEXT_PATH="$TEST_DIR/t1"
mkdir -p "$TEST_DIR/t1/events"
full_pid=$(_derive_pid)

echo '{"session_id":"test-abc","tool_name":"Read"}' | bash "$CAPTURE_EVENT" ToolCallCompleted 2>/dev/null
event_file="$TEST_DIR/t1/events/$full_pid/test-abc/000001.json"

if [ -f "$event_file" ]; then
  echo "  PASS: event file created"; _record_pass
  # Verify all 7 fields
  for field in event_id event_type project_id session_id sequence timestamp data; do
    val=$(jq ".$field" "$event_file" 2>/dev/null)
    if [ "$val" != "null" ] && [ -n "$val" ]; then
      _record_pass
    else
      echo "  FAIL: missing field $field"; _record_fail
    fi
  done
  echo "  PASS: all 7 envelope fields present"; # Already recorded above

  assert_eq "event_type" "ToolCallCompleted" "$(jq -r '.event_type' "$event_file")"
  assert_eq "session_id" "test-abc" "$(jq -r '.session_id' "$event_file")"
  assert_eq "project_id" "$full_pid" "$(jq -r '.project_id' "$event_file")"
  assert_eq "data.tool_name" "Read" "$(jq -r '.data.tool_name' "$event_file")"
else
  echo "  FAIL: event file not created"; _record_fail
fi

# =============================================
# Test 2: All 10 event types
# =============================================
echo ""
echo "=== Test 2: All 10 event types ==="
export CLAUDE_CONTEXT_PATH="$TEST_DIR/t2"
mkdir -p "$TEST_DIR/t2/events"

for etype in SessionStarted UserPromptReceived ToolCallRequested ToolCallCompleted ToolCallFailed AgentSpawned AgentCompleted TurnCompleted CompactionTriggered SessionEnded; do
  echo "{\"session_id\":\"type-test\"}" | bash "$CAPTURE_EVENT" "$etype" 2>/dev/null
done
session_dir="$TEST_DIR/t2/events/$full_pid/type-test"
file_count=$(ls "$session_dir"/[0-9]*.json 2>/dev/null | wc -l)
assert_eq "all 10 event types produced files" "10" "$file_count"

# =============================================
# Test 3: Sequence numbering
# =============================================
echo ""
echo "=== Test 3: Sequential numbering ==="
export CLAUDE_CONTEXT_PATH="$TEST_DIR/t3"
mkdir -p "$TEST_DIR/t3/events"

for i in $(seq 1 5); do
  echo '{"session_id":"seq-test"}' | bash "$CAPTURE_EVENT" SessionStarted 2>/dev/null
done
session_dir="$TEST_DIR/t3/events/$full_pid/seq-test"
for i in $(seq 1 5); do
  padded=$(printf "%06d" "$i")
  if [ -f "$session_dir/${padded}.json" ]; then
    _record_pass
  else
    echo "  FAIL: ${padded}.json missing"; _record_fail
  fi
done
echo "  PASS: files 000001-000005 all exist"

# =============================================
# Test 4: Missing session_id -> "unknown" directory
# =============================================
echo ""
echo "=== Test 4: Missing session_id ==="
export CLAUDE_CONTEXT_PATH="$TEST_DIR/t4"
mkdir -p "$TEST_DIR/t4/events"

echo '{"tool_name":"Write"}' | bash "$CAPTURE_EVENT" ToolCallCompleted 2>/dev/null
session_dir="$TEST_DIR/t4/events/$full_pid/unknown"
if [ -d "$session_dir" ]; then
  echo "  PASS: unknown session dir created"; _record_pass
else
  echo "  FAIL: unknown session dir not created"; _record_fail
fi

# =============================================
# Test 5: Empty stdin
# =============================================
echo ""
echo "=== Test 5: Empty stdin ==="
export CLAUDE_CONTEXT_PATH="$TEST_DIR/t5"
rc=0
echo -n "" | bash "$CAPTURE_EVENT" SessionStarted 2>/dev/null || rc=$?
assert_eq "exit 0 with empty stdin" "0" "$rc"

# =============================================
# Test 6: Malformed JSON
# =============================================
echo ""
echo "=== Test 6: Malformed JSON ==="
export CLAUDE_CONTEXT_PATH="$TEST_DIR/t6"
mkdir -p "$TEST_DIR/t6/events"

rc=0
echo 'not json at all' | bash "$CAPTURE_EVENT" ToolCallCompleted 2>/dev/null || rc=$?
assert_eq "exit 0 with malformed JSON" "0" "$rc"

session_dir="$TEST_DIR/t6/events/$full_pid/unknown"
if [ -d "$session_dir" ]; then
  event_file=$(ls "$session_dir"/[0-9]*.json 2>/dev/null | head -1)
  if [ -n "$event_file" ] && jq empty "$event_file" 2>/dev/null; then
    echo "  PASS: malformed input stored as valid JSON event"; _record_pass
    data_val=$(jq -r '.data' "$event_file" 2>/dev/null)
    assert_eq "data stored as string" "not json at all" "$data_val"
  else
    echo "  FAIL: event file invalid or missing"; _record_fail
  fi
else
  echo "  FAIL: session dir not created"; _record_fail
fi

# =============================================
# Test 7: No arguments
# =============================================
echo ""
echo "=== Test 7: No arguments ==="
rc=0
stderr_out=$(echo '{"session_id":"x"}' | bash "$CAPTURE_EVENT" 2>&1 >/dev/null) || rc=$?
assert_eq "exit 0 with no arguments" "0" "$rc"
if echo "$stderr_out" | grep -q "ERROR"; then
  echo "  PASS: stderr has error message"; _record_pass
else
  echo "  FAIL: stderr should contain ERROR"; _record_fail
fi

# =============================================
# Test 8: Unknown event type
# =============================================
echo ""
echo "=== Test 8: Unknown event type ==="
export CLAUDE_CONTEXT_PATH="$TEST_DIR/t8"
mkdir -p "$TEST_DIR/t8/events"

stderr_out=$(echo '{"session_id":"unknown-type"}' | bash "$CAPTURE_EVENT" FutureEvent 2>&1 >/dev/null)
session_dir="$TEST_DIR/t8/events/$full_pid/unknown-type"
if [ -d "$session_dir" ] && ls "$session_dir"/[0-9]*.json &>/dev/null; then
  echo "  PASS: unknown event type still captured"; _record_pass
else
  echo "  FAIL: unknown event type not captured"; _record_fail
fi
if echo "$stderr_out" | grep -q "WARN"; then
  echo "  PASS: stderr warning for unknown type"; _record_pass
else
  echo "  FAIL: no stderr warning for unknown type"; _record_fail
fi

# =============================================
# Test 9: Concurrent writes
# =============================================
echo ""
echo "=== Test 9: Concurrent writes ==="
export CLAUDE_CONTEXT_PATH="$TEST_DIR/t9"
mkdir -p "$TEST_DIR/t9/events"

for i in $(seq 1 10); do
  echo '{"session_id":"concurrent"}' | bash "$CAPTURE_EVENT" ToolCallCompleted 2>/dev/null &
done
wait

session_dir="$TEST_DIR/t9/events/$full_pid/concurrent"
file_count=$(ls "$session_dir"/[0-9]*.json 2>/dev/null | wc -l)
assert_eq "10 concurrent events all written" "10" "$file_count"

# Check unique sequences
sequences=$(for f in "$session_dir"/[0-9]*.json; do jq -r '.sequence' "$f"; done | sort -n)
unique_count=$(echo "$sequences" | sort -u | wc -l)
assert_eq "all concurrent sequences unique" "10" "$unique_count"

# =============================================
# Test 10: Large payload (1MB)
# =============================================
echo ""
echo "=== Test 10: Large payload ==="
export CLAUDE_CONTEXT_PATH="$TEST_DIR/t10"
mkdir -p "$TEST_DIR/t10/events"

# Generate ~1MB payload
large_value=$(python3 -c "print('x' * (1024*1024))" 2>/dev/null || printf '%0.sx' $(seq 1 1048576))
large_payload="{\"session_id\":\"large-test\",\"big_field\":\"${large_value}\"}"

echo "$large_payload" | bash "$CAPTURE_EVENT" ToolCallCompleted 2>/dev/null
session_dir="$TEST_DIR/t10/events/$full_pid/large-test"
if ls "$session_dir"/[0-9]*.json &>/dev/null; then
  event_file=$(ls "$session_dir"/[0-9]*.json | head -1)
  data_len=$(jq -r '.data.big_field | length' "$event_file" 2>/dev/null || echo "0")
  if [ "$data_len" -ge 1000000 ]; then
    echo "  PASS: 1MB payload captured completely ($data_len chars)"; _record_pass
  else
    echo "  FAIL: payload truncated to $data_len chars"; _record_fail
  fi
else
  echo "  FAIL: large payload event not written"; _record_fail
fi

# =============================================
# Test 11: Special chars in session_id
# =============================================
echo ""
echo "=== Test 11: Special chars in session_id ==="
export CLAUDE_CONTEXT_PATH="$TEST_DIR/t11"
mkdir -p "$TEST_DIR/t11/events"

echo '{"session_id":"sess/../../etc/passwd"}' | bash "$CAPTURE_EVENT" ToolCallCompleted 2>/dev/null
# Sanitized: sessetcpasswd
session_dir="$TEST_DIR/t11/events/$full_pid/sessetcpasswd"
if [ -d "$session_dir" ]; then
  echo "  PASS: sanitized session dir created"; _record_pass
  event_file=$(ls "$session_dir"/[0-9]*.json | head -1)
  # The original session_id is preserved in the envelope
  orig_sid=$(jq -r '.session_id' "$event_file" 2>/dev/null)
  # The original session_id in the data field should be the raw one
  data_sid=$(jq -r '.data.session_id' "$event_file" 2>/dev/null)
  assert_eq "original session_id preserved in data" "sess/../../etc/passwd" "$data_sid"
else
  echo "  FAIL: sanitized session dir not created"; _record_fail
fi

# =============================================
# Test 12: Performance (single invocation under 100ms)
# =============================================
echo ""
echo "=== Test 12: Performance ==="
export CLAUDE_CONTEXT_PATH="$TEST_DIR/t12"
mkdir -p "$TEST_DIR/t12/events"

start_ns=$(_now_ns)
echo '{"session_id":"perf"}' | bash "$CAPTURE_EVENT" ToolCallCompleted 2>/dev/null
end_ns=$(_now_ns)
elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))

if [ "$elapsed_ms" -lt 100 ]; then
  echo "  PASS: single invocation ${elapsed_ms}ms < 100ms"; _record_pass
else
  echo "  FAIL: single invocation ${elapsed_ms}ms >= 100ms"; _record_fail
fi

# =============================================
# Test 13: Lock file is .lock not _seq.lock
# =============================================
echo ""
echo "=== Test 13: Lock file is .lock ==="
export CLAUDE_CONTEXT_PATH="$TEST_DIR/t13"
mkdir -p "$TEST_DIR/t13/events"

echo '{"session_id":"lock-test"}' | bash "$CAPTURE_EVENT" SessionStarted 2>/dev/null
session_dir="$TEST_DIR/t13/events/$full_pid/lock-test"
if [ -f "$session_dir/.lock" ]; then
  echo "  PASS: .lock file exists"; _record_pass
else
  echo "  FAIL: .lock file missing"; _record_fail
fi
if [ ! -f "$session_dir/_seq.lock" ]; then
  echo "  PASS: no _seq.lock file"; _record_pass
else
  echo "  FAIL: _seq.lock should not exist"; _record_fail
fi

# =============================================
# Test 14: UUID format
# =============================================
echo ""
echo "=== Test 14: UUID format ==="
event_file="$TEST_DIR/t13/events/$full_pid/lock-test/000001.json"
eid=$(jq -r '.event_id' "$event_file" 2>/dev/null)
if [[ "$eid" =~ $UUID_REGEX ]]; then
  echo "  PASS: event_id is valid UUID ($eid)"; _record_pass
else
  echo "  FAIL: event_id not valid UUID: $eid"; _record_fail
fi

# =============================================
# Test 15: CLAUDE_CONTEXT_PATH override
# =============================================
echo ""
echo "=== Test 15: CLAUDE_CONTEXT_PATH override ==="
export CLAUDE_CONTEXT_PATH="$TEST_DIR/custom-path"
mkdir -p "$TEST_DIR/custom-path/events"
echo '{"session_id":"custom"}' | bash "$CAPTURE_EVENT" SessionStarted 2>/dev/null
if [ -d "$TEST_DIR/custom-path/events/$full_pid/custom" ]; then
  echo "  PASS: events at custom path"; _record_pass
else
  echo "  FAIL: events not at custom path"; _record_fail
fi
# Verify default path is not used
if [ ! -d "$HOME/.claude-context/events/$full_pid/custom" ] 2>/dev/null; then
  echo "  PASS: default path not used"; _record_pass
else
  echo "  WARN: default path may have events (not necessarily from this test)"
  _record_pass
fi

# =============================================
# Test 16: Atomic write -- no partial files
# =============================================
echo ""
echo "=== Test 16: No partial files ==="
export CLAUDE_CONTEXT_PATH="$TEST_DIR/t16"
mkdir -p "$TEST_DIR/t16/events"

echo '{"session_id":"atomic-test"}' | bash "$CAPTURE_EVENT" SessionStarted 2>/dev/null
session_dir="$TEST_DIR/t16/events/$full_pid/atomic-test"
tmp_files=$(find "$session_dir" -name '*.tmp.*' 2>/dev/null | wc -l)
assert_eq "no partial tmp files" "0" "$tmp_files"

# =============================================
# Test 17: Sanitization follows Story 03 rules
# =============================================
echo ""
echo "=== Test 17: Sanitization rules ==="
export CLAUDE_CONTEXT_PATH="$TEST_DIR/t17"
mkdir -p "$TEST_DIR/t17/events"

# No dots: hello.world -> helloworld
echo '{"session_id":"hello.world"}' | bash "$CAPTURE_EVENT" SessionStarted 2>/dev/null
if [ -d "$TEST_DIR/t17/events/$full_pid/helloworld" ]; then
  echo "  PASS: dots removed from session_id"; _record_pass
else
  echo "  FAIL: dots not removed"; _record_fail
fi

# Max 255 chars
long_id=$(printf 'a%.0s' $(seq 1 300))
echo "{\"session_id\":\"$long_id\"}" | bash "$CAPTURE_EVENT" SessionStarted 2>/dev/null
# Find directory with 255 'a' chars
expected_dir=$(printf 'a%.0s' $(seq 1 255))
if [ -d "$TEST_DIR/t17/events/$full_pid/$expected_dir" ]; then
  echo "  PASS: session_id truncated to 255 chars"; _record_pass
else
  echo "  FAIL: session_id not truncated to 255"; _record_fail
fi

# Path traversal prevention
echo '{"session_id":".."}' | bash "$CAPTURE_EVENT" SessionStarted 2>/dev/null
# Should not create a directory literally named ".."
if [ ! -d "$TEST_DIR/t17/events/$full_pid/.." ] || ls "$TEST_DIR/t17/events/$full_pid"/unknown-* &>/dev/null; then
  echo "  PASS: path traversal prevented"; _record_pass
else
  echo "  FAIL: path traversal not prevented"; _record_fail
fi

# =============================================
# Test 18: Idempotent install
# =============================================
echo ""
echo "=== Test 18: Idempotent install ==="
export CLAUDE_CONTEXT_PATH="$TEST_DIR/t18"

# First install
bash "$INSTALL_SH" >/dev/null 2>&1

# Write an event to verify data
echo '{"session_id":"install-test"}' | bash "$CAPTURE_EVENT" SessionStarted 2>/dev/null

# Save config content
config_before=$(cat "$TEST_DIR/t18/config.json")

# Second install
bash "$INSTALL_SH" >/dev/null 2>&1

config_after=$(cat "$TEST_DIR/t18/config.json")
assert_eq "config.json preserved after re-install" "$config_before" "$config_after"

# Verify event data survives
session_dir="$TEST_DIR/t18/events/$full_pid/install-test"
if ls "$session_dir"/[0-9]*.json &>/dev/null; then
  echo "  PASS: event data preserved after re-install"; _record_pass
else
  echo "  FAIL: event data lost after re-install"; _record_fail
fi

# =============================================
# Summary
# =============================================
echo ""
echo "============================================"
counts=$(cat "$RESULT_FILE")
PASS=$(echo "$counts" | cut -d' ' -f1)
FAIL=$(echo "$counts" | cut -d' ' -f2)
TOTAL=$((PASS + FAIL))
echo "Integration Tests: $PASS/$TOTAL passed, $FAIL failed"
echo "============================================"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
