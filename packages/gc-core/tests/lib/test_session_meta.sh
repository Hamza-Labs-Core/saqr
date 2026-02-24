#!/usr/bin/env bash
# Tests for gc_session_meta_create, gc_session_meta_update, gc_session_meta_read (Task 03/08)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Use a temp directory as the context store so we don't touch real data
TEST_DIR="$(mktemp -d)"
export CLAUDE_CONTEXT_PATH="$TEST_DIR/store"

# Source the module under test
source "$PROJECT_ROOT/src/lib/session_meta.sh"

PASS=0
FAIL=0

pass() {
  PASS=$((PASS + 1))
  echo "  PASS: $1"
}

fail() {
  FAIL=$((FAIL + 1))
  echo "  FAIL: $1" >&2
}

cleanup() {
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

# ===================================================================
echo "=== Test 1: First event creates session.json with all fields ==="
# ===================================================================
SESSION1_DIR="$TEST_DIR/store/events/myproj-abc123/sess-001"
mkdir -p "$SESSION1_DIR"

gc_session_meta_create "$SESSION1_DIR" "sess-001" "myproj-abc123" \
  "/home/user/my-project" "manual" "claude-opus-4-6" "2026-02-14T10:30:00Z"

if [[ -f "$SESSION1_DIR/session.json" ]]; then
  pass "session.json was created"
else
  fail "session.json was not created"
fi

# Validate all fields
json="$(cat "$SESSION1_DIR/session.json")"

val=$(printf '%s' "$json" | jq -r '.session_id')
if [[ "$val" == "sess-001" ]]; then
  pass "session_id is correct"
else
  fail "session_id expected 'sess-001', got '$val'"
fi

val=$(printf '%s' "$json" | jq -r '.project_id')
if [[ "$val" == "myproj-abc123" ]]; then
  pass "project_id is correct"
else
  fail "project_id expected 'myproj-abc123', got '$val'"
fi

val=$(printf '%s' "$json" | jq -r '.project_dir')
if [[ "$val" == "/home/user/my-project" ]]; then
  pass "project_dir is correct"
else
  fail "project_dir expected '/home/user/my-project', got '$val'"
fi

val=$(printf '%s' "$json" | jq -r '.started_at')
if [[ "$val" == "2026-02-14T10:30:00Z" ]]; then
  pass "started_at is correct"
else
  fail "started_at expected '2026-02-14T10:30:00Z', got '$val'"
fi

val=$(printf '%s' "$json" | jq -r '.source')
if [[ "$val" == "manual" ]]; then
  pass "source is correct"
else
  fail "source expected 'manual', got '$val'"
fi

val=$(printf '%s' "$json" | jq -r '.model')
if [[ "$val" == "claude-opus-4-6" ]]; then
  pass "model is correct"
else
  fail "model expected 'claude-opus-4-6', got '$val'"
fi

val=$(printf '%s' "$json" | jq '.event_count')
if [[ "$val" == "1" ]]; then
  pass "event_count is 1"
else
  fail "event_count expected 1, got '$val'"
fi

val=$(printf '%s' "$json" | jq -r '.last_event_at')
if [[ "$val" == "2026-02-14T10:30:00Z" ]]; then
  pass "last_event_at matches started_at"
else
  fail "last_event_at expected '2026-02-14T10:30:00Z', got '$val'"
fi

val=$(printf '%s' "$json" | jq -r '.last_event_type')
if [[ "$val" == "SessionStarted" ]]; then
  pass "last_event_type is SessionStarted"
else
  fail "last_event_type expected 'SessionStarted', got '$val'"
fi

val=$(printf '%s' "$json" | jq -r '.last_prompt')
if [[ "$val" == "null" ]]; then
  pass "last_prompt is null"
else
  fail "last_prompt expected null, got '$val'"
fi

val=$(printf '%s' "$json" | jq -r '.ended_at')
if [[ "$val" == "null" ]]; then
  pass "ended_at is null"
else
  fail "ended_at expected null, got '$val'"
fi

val=$(printf '%s' "$json" | jq -r '.previous_session_id')
if [[ "$val" == "null" ]]; then
  pass "previous_session_id is null"
else
  fail "previous_session_id expected null, got '$val'"
fi

# Validate it's valid JSON
if printf '%s' "$json" | jq empty 2>/dev/null; then
  pass "session.json is valid JSON after create"
else
  fail "session.json is not valid JSON after create"
fi

# ===================================================================
echo ""
echo "=== Test 2: 10th event has correct event_count and last_event_at ==="
# ===================================================================
SESSION2_DIR="$TEST_DIR/store/events/myproj-abc123/sess-002"
mkdir -p "$SESSION2_DIR"

gc_session_meta_create "$SESSION2_DIR" "sess-002" "myproj-abc123" \
  "/home/user/my-project" "auto" "claude-opus-4-6" "2026-02-14T10:00:00Z"

# Simulate events 2 through 10
for i in $(seq 2 10); do
  ts="2026-02-14T10:0${i}:00Z"
  gc_session_meta_update "$SESSION2_DIR" "TurnCompleted" "$ts"
done

json="$(cat "$SESSION2_DIR/session.json")"

val=$(printf '%s' "$json" | jq '.event_count')
if [[ "$val" == "10" ]]; then
  pass "event_count is 10 after 10 events"
else
  fail "event_count expected 10, got '$val'"
fi

val=$(printf '%s' "$json" | jq -r '.last_event_at')
if [[ "$val" == "2026-02-14T10:010:00Z" ]]; then
  # The 10th event's timestamp
  pass "last_event_at is the 10th event's timestamp"
else
  # Let's check for a reasonable value
  expected_ts="2026-02-14T10:010:00Z"
  fail "last_event_at expected '$expected_ts', got '$val'"
fi

val=$(printf '%s' "$json" | jq -r '.last_event_type')
if [[ "$val" == "TurnCompleted" ]]; then
  pass "last_event_type is TurnCompleted"
else
  fail "last_event_type expected 'TurnCompleted', got '$val'"
fi

# Validate valid JSON
if printf '%s' "$json" | jq empty 2>/dev/null; then
  pass "session.json is valid JSON after 10 updates"
else
  fail "session.json is not valid JSON after 10 updates"
fi

# ===================================================================
echo ""
echo "=== Test 3: UserPromptReceived updates last_prompt ==="
# ===================================================================
SESSION3_DIR="$TEST_DIR/store/events/myproj-abc123/sess-003"
mkdir -p "$SESSION3_DIR"

gc_session_meta_create "$SESSION3_DIR" "sess-003" "myproj-abc123" \
  "/home/user/my-project" "manual" "claude-opus-4-6" "2026-02-14T11:00:00Z"

gc_session_meta_update "$SESSION3_DIR" "UserPromptReceived" \
  "2026-02-14T11:01:00Z" "Fix the auth bug in handler.ts"

json="$(cat "$SESSION3_DIR/session.json")"

val=$(printf '%s' "$json" | jq -r '.last_prompt')
if [[ "$val" == "Fix the auth bug in handler.ts" ]]; then
  pass "last_prompt updated from UserPromptReceived"
else
  fail "last_prompt expected 'Fix the auth bug in handler.ts', got '$val'"
fi

val=$(printf '%s' "$json" | jq -r '.last_event_type')
if [[ "$val" == "UserPromptReceived" ]]; then
  pass "last_event_type is UserPromptReceived"
else
  fail "last_event_type expected 'UserPromptReceived', got '$val'"
fi

val=$(printf '%s' "$json" | jq '.event_count')
if [[ "$val" == "2" ]]; then
  pass "event_count is 2 after prompt event"
else
  fail "event_count expected 2, got '$val'"
fi

# Update prompt again to verify it changes
gc_session_meta_update "$SESSION3_DIR" "UserPromptReceived" \
  "2026-02-14T11:05:00Z" "Now fix the tests too"

json="$(cat "$SESSION3_DIR/session.json")"
val=$(printf '%s' "$json" | jq -r '.last_prompt')
if [[ "$val" == "Now fix the tests too" ]]; then
  pass "last_prompt updated on second prompt"
else
  fail "last_prompt expected 'Now fix the tests too', got '$val'"
fi

# ===================================================================
echo ""
echo "=== Test 4: SessionEnded sets ended_at ==="
# ===================================================================
SESSION4_DIR="$TEST_DIR/store/events/myproj-abc123/sess-004"
mkdir -p "$SESSION4_DIR"

gc_session_meta_create "$SESSION4_DIR" "sess-004" "myproj-abc123" \
  "/home/user/my-project" "manual" "claude-opus-4-6" "2026-02-14T12:00:00Z"

# Some intermediate events
gc_session_meta_update "$SESSION4_DIR" "TurnCompleted" "2026-02-14T12:01:00Z"
gc_session_meta_update "$SESSION4_DIR" "TurnCompleted" "2026-02-14T12:02:00Z"

# End the session
gc_session_meta_update "$SESSION4_DIR" "SessionEnded" "2026-02-14T12:30:00Z"

json="$(cat "$SESSION4_DIR/session.json")"

val=$(printf '%s' "$json" | jq -r '.ended_at')
if [[ "$val" == "2026-02-14T12:30:00Z" ]]; then
  pass "ended_at set on SessionEnded"
else
  fail "ended_at expected '2026-02-14T12:30:00Z', got '$val'"
fi

val=$(printf '%s' "$json" | jq -r '.last_event_type')
if [[ "$val" == "SessionEnded" ]]; then
  pass "last_event_type is SessionEnded"
else
  fail "last_event_type expected 'SessionEnded', got '$val'"
fi

val=$(printf '%s' "$json" | jq '.event_count')
if [[ "$val" == "4" ]]; then
  pass "event_count is 4 (create + 2 turns + ended)"
else
  fail "event_count expected 4, got '$val'"
fi

# ===================================================================
echo ""
echo "=== Test 5: session.json is always valid JSON after any update ==="
# ===================================================================
SESSION5_DIR="$TEST_DIR/store/events/myproj-abc123/sess-005"
mkdir -p "$SESSION5_DIR"

gc_session_meta_create "$SESSION5_DIR" "sess-005" "myproj-abc123" \
  "/home/user/my-project" "manual" "claude-opus-4-6" "2026-02-14T13:00:00Z"

all_valid=true
for i in $(seq 1 20); do
  gc_session_meta_update "$SESSION5_DIR" "TurnCompleted" "2026-02-14T13:${i}:00Z"
  if ! jq empty "$SESSION5_DIR/session.json" 2>/dev/null; then
    all_valid=false
    fail "session.json invalid JSON after update $i"
    break
  fi
done

if [[ "$all_valid" == "true" ]]; then
  pass "session.json is valid JSON after all 20 updates"
fi

# ===================================================================
echo ""
echo "=== Test 6: No global lock files exist ==="
# ===================================================================
# Check that no .sessions.lock file was created anywhere in the store
lock_files=$(find "$TEST_DIR/store" -name ".sessions.lock" 2>/dev/null | wc -l)
if [[ "$lock_files" -eq 0 ]]; then
  pass "no global .sessions.lock files exist"
else
  fail "found $lock_files .sessions.lock files"
fi

# ===================================================================
echo ""
echo "=== Test 7: Two different sessions updating concurrently -- no interference ==="
# ===================================================================
SESSION7A_DIR="$TEST_DIR/store/events/myproj-abc123/sess-007a"
SESSION7B_DIR="$TEST_DIR/store/events/myproj-abc123/sess-007b"
mkdir -p "$SESSION7A_DIR" "$SESSION7B_DIR"

gc_session_meta_create "$SESSION7A_DIR" "sess-007a" "myproj-abc123" \
  "/home/user/my-project" "manual" "claude-opus-4-6" "2026-02-14T14:00:00Z"
gc_session_meta_create "$SESSION7B_DIR" "sess-007b" "myproj-abc123" \
  "/home/user/my-project" "manual" "claude-opus-4-6" "2026-02-14T14:00:00Z"

# Run concurrent updates on both sessions
(
  source "$PROJECT_ROOT/src/lib/session_meta.sh"
  for i in $(seq 1 10); do
    gc_session_meta_update "$SESSION7A_DIR" "TurnCompleted" "2026-02-14T14:0${i}:00Z"
  done
) &
pid_a=$!

(
  source "$PROJECT_ROOT/src/lib/session_meta.sh"
  for i in $(seq 1 10); do
    gc_session_meta_update "$SESSION7B_DIR" "TurnCompleted" "2026-02-14T14:0${i}:00Z"
  done
) &
pid_b=$!

wait "$pid_a" || true
wait "$pid_b" || true

json_a="$(cat "$SESSION7A_DIR/session.json")"
json_b="$(cat "$SESSION7B_DIR/session.json")"

count_a=$(printf '%s' "$json_a" | jq '.event_count')
count_b=$(printf '%s' "$json_b" | jq '.event_count')

if [[ "$count_a" == "11" ]]; then
  pass "session A event_count is 11 (1 create + 10 updates)"
else
  fail "session A event_count expected 11, got '$count_a'"
fi

if [[ "$count_b" == "11" ]]; then
  pass "session B event_count is 11 (1 create + 10 updates)"
else
  fail "session B event_count expected 11, got '$count_b'"
fi

# Verify session IDs are independent
sid_a=$(printf '%s' "$json_a" | jq -r '.session_id')
sid_b=$(printf '%s' "$json_b" | jq -r '.session_id')
if [[ "$sid_a" == "sess-007a" && "$sid_b" == "sess-007b" ]]; then
  pass "session IDs remain independent"
else
  fail "session IDs mixed up: A='$sid_a', B='$sid_b'"
fi

# Both must be valid JSON
if printf '%s' "$json_a" | jq empty 2>/dev/null && printf '%s' "$json_b" | jq empty 2>/dev/null; then
  pass "both session.json files are valid JSON after concurrent updates"
else
  fail "one or both session.json files are invalid JSON"
fi

# ===================================================================
echo ""
echo "=== Test 8: session.json is written atomically (no partial reads) ==="
# ===================================================================
SESSION8_DIR="$TEST_DIR/store/events/myproj-abc123/sess-008"
mkdir -p "$SESSION8_DIR"

gc_session_meta_create "$SESSION8_DIR" "sess-008" "myproj-abc123" \
  "/home/user/my-project" "manual" "claude-opus-4-6" "2026-02-14T15:00:00Z"

# Write updates in background while reading concurrently
(
  source "$PROJECT_ROOT/src/lib/session_meta.sh"
  for i in $(seq 1 50); do
    gc_session_meta_update "$SESSION8_DIR" "TurnCompleted" "2026-02-14T15:${i}:00Z"
  done
) &
writer_pid=$!

partial_reads=0
for _ in $(seq 1 100); do
  if [[ -f "$SESSION8_DIR/session.json" ]]; then
    content="$(cat "$SESSION8_DIR/session.json" 2>/dev/null || true)"
    if [[ -n "$content" ]]; then
      if ! printf '%s' "$content" | jq empty 2>/dev/null; then
        partial_reads=$((partial_reads + 1))
      fi
    fi
  fi
done

wait "$writer_pid" || true

if [[ "$partial_reads" -eq 0 ]]; then
  pass "no partial reads detected during concurrent write/read"
else
  fail "detected $partial_reads partial reads during concurrent write/read"
fi

# ===================================================================
echo ""
echo "=== Test 9: gc_session_meta_read returns correct content ==="
# ===================================================================
SESSION9_DIR="$TEST_DIR/store/events/myproj-abc123/sess-009"
mkdir -p "$SESSION9_DIR"

gc_session_meta_create "$SESSION9_DIR" "sess-009" "myproj-abc123" \
  "/home/user/my-project" "manual" "claude-opus-4-6" "2026-02-14T16:00:00Z"

read_result="$(gc_session_meta_read "$SESSION9_DIR")"
if printf '%s' "$read_result" | jq empty 2>/dev/null; then
  pass "gc_session_meta_read returns valid JSON"
else
  fail "gc_session_meta_read did not return valid JSON"
fi

val=$(printf '%s' "$read_result" | jq -r '.session_id')
if [[ "$val" == "sess-009" ]]; then
  pass "gc_session_meta_read returns correct session_id"
else
  fail "gc_session_meta_read session_id expected 'sess-009', got '$val'"
fi

# ===================================================================
echo ""
echo "=== Test 10: gc_session_meta_read fails for missing session.json ==="
# ===================================================================
EMPTY_DIR="$TEST_DIR/store/events/myproj-abc123/sess-empty"
mkdir -p "$EMPTY_DIR"

if gc_session_meta_read "$EMPTY_DIR" 2>/dev/null; then
  fail "gc_session_meta_read should fail for missing session.json"
else
  pass "gc_session_meta_read returns non-zero for missing session.json"
fi

# ===================================================================
echo ""
echo "=== Test 11: gc_session_meta_update fails for missing session.json ==="
# ===================================================================
MISSING_DIR="$TEST_DIR/store/events/myproj-abc123/sess-missing"
mkdir -p "$MISSING_DIR"

if gc_session_meta_update "$MISSING_DIR" "TurnCompleted" "2026-02-14T17:00:00Z" 2>/dev/null; then
  fail "gc_session_meta_update should fail for missing session.json"
else
  pass "gc_session_meta_update returns non-zero for missing session.json"
fi

# ===================================================================
echo ""
echo "================================="
echo "Results: $PASS passed, $FAIL failed"
echo "================================="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
