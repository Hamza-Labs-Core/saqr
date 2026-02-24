#!/usr/bin/env bash
# Tests for gc_write_event (Task 03/06 -- Event File Writing)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Use a temp directory as the context store so we don't touch real data
TEST_DIR="$(mktemp -d)"
export CLAUDE_CONTEXT_PATH="$TEST_DIR/store"
export GC_PROJECT_DIR="/home/user/test-project"

# Source the module under test (which sources all dependencies)
source "$PROJECT_ROOT/src/lib/event_write.sh"

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

# Derive the project_id that gc_write_event will use
PROJECT_ID="$(gc_derive_project_id "$GC_PROJECT_DIR")"

# ===================================================================
echo "=== Test 1: Write 10 events -- files 000001.json through 000010.json ==="
# ===================================================================
SESSION_1="test-session-001"
for i in $(seq 1 10); do
  result="$(gc_write_event "$SESSION_1" "TurnCompleted" '{"turn": '$i'}')"
  if [[ ! -f "$result" ]]; then
    fail "event file $i was not created at: $result"
  fi
done

SANITIZED_1="$(gc_sanitize_session_id "$SESSION_1")"
SESSION_DIR_1="$CLAUDE_CONTEXT_PATH/events/$PROJECT_ID/$SANITIZED_1"

all_exist=true
for i in $(seq 1 10); do
  padded="$(printf "%06d" "$i")"
  if [[ ! -f "$SESSION_DIR_1/${padded}.json" ]]; then
    fail "file ${padded}.json does not exist"
    all_exist=false
  fi
done

if [[ "$all_exist" == "true" ]]; then
  pass "files 000001.json through 000010.json all exist"
fi

# Each file has the correct 7-field envelope
all_valid=true
for i in $(seq 1 10); do
  padded="$(printf "%06d" "$i")"
  json="$(cat "$SESSION_DIR_1/${padded}.json")"
  # Check all 7 fields exist
  for field in event_id event_type project_id session_id sequence timestamp data; do
    val="$(printf '%s' "$json" | jq ".$field // \"__MISSING__\"" 2>/dev/null)"
    if [[ "$val" == '"__MISSING__"' ]]; then
      fail "file ${padded}.json missing field '$field'"
      all_valid=false
    fi
  done
done

if [[ "$all_valid" == "true" ]]; then
  pass "all 10 event files have all 7 required fields"
fi

# ===================================================================
echo ""
echo "=== Test 2: Sequence field matches filename ==="
# ===================================================================
all_match=true
for i in $(seq 1 10); do
  padded="$(printf "%06d" "$i")"
  json="$(cat "$SESSION_DIR_1/${padded}.json")"
  seq_val="$(printf '%s' "$json" | jq '.sequence')"
  if [[ "$seq_val" != "$i" ]]; then
    fail "file ${padded}.json has sequence=$seq_val, expected $i"
    all_match=false
  fi
done

if [[ "$all_match" == "true" ]]; then
  pass "sequence field matches filename for all 10 events"
fi

# ===================================================================
echo ""
echo "=== Test 3: String data is accepted (malformed JSON fallback) ==="
# ===================================================================
SESSION_3="test-session-003"
SANITIZED_3="$(gc_sanitize_session_id "$SESSION_3")"
SESSION_DIR_3="$CLAUDE_CONTEXT_PATH/events/$PROJECT_ID/$SANITIZED_3"

# Write with string data -- should be accepted since data can be object or string
if result3="$(gc_write_event "$SESSION_3" "StringDataEvent" '"malformed input stored as string"' 2>/dev/null)"; then
  if [[ -f "$result3" ]]; then
    json3="$(cat "$result3")"
    data3="$(printf '%s' "$json3" | jq -r '.data')"
    if [[ "$data3" == "malformed input stored as string" ]]; then
      pass "string data event written successfully with correct data"
    else
      fail "string data event data mismatch: got '$data3'"
    fi
  else
    fail "string data event file not found at '$result3'"
  fi
else
  fail "string data event was rejected (should be accepted)"
fi

# ===================================================================
echo ""
echo "=== Test 4: Concurrent writes -- all get unique sequence numbers ==="
# ===================================================================
SESSION_4="test-session-004"
SANITIZED_4="$(gc_sanitize_session_id "$SESSION_4")"
SESSION_DIR_4="$CLAUDE_CONTEXT_PATH/events/$PROJECT_ID/$SANITIZED_4"

# Launch 10 parallel writes
pids=()
for i in $(seq 1 10); do
  (
    export CLAUDE_CONTEXT_PATH="$TEST_DIR/store"
    export GC_PROJECT_DIR="/home/user/test-project"
    source "$PROJECT_ROOT/src/lib/event_write.sh"
    gc_write_event "$SESSION_4" "ConcurrentEvent" '{"worker": '$i'}' >/dev/null 2>&1
  ) &
  pids+=($!)
done

# Wait for all to finish
for pid in "${pids[@]}"; do
  wait "$pid" || true
done

# Count event files (exclude session.json and .lock and orphan files)
event_files="$(find "$SESSION_DIR_4" -maxdepth 1 -name '[0-9]*.json' -not -name 'session.json' 2>/dev/null | sort)"
event_count="$(echo "$event_files" | grep -c . || true)"
orphan_files="$(find "$SESSION_DIR_4" -maxdepth 1 -name 'orphan-*.json' 2>/dev/null | wc -l)"
total_written=$((event_count + orphan_files))

if [[ "$total_written" -eq 10 ]]; then
  pass "all 10 concurrent writes produced files (sequenced: $event_count, orphans: $orphan_files)"
else
  fail "expected 10 total event files, got $total_written (sequenced: $event_count, orphans: $orphan_files)"
fi

# Check for unique sequence numbers among sequenced files
if [[ "$event_count" -gt 0 ]]; then
  sequences="$(for f in $event_files; do printf '%s' "$(cat "$f")" | jq '.sequence'; done | sort -n)"
  unique_seqs="$(echo "$sequences" | sort -u | wc -l)"
  if [[ "$unique_seqs" -eq "$event_count" ]]; then
    pass "all sequenced events have unique sequence numbers"
  else
    fail "duplicate sequence numbers detected ($unique_seqs unique out of $event_count)"
  fi
fi

# Check for no gaps in sequence numbers among sequenced files
if [[ "$event_count" -gt 0 ]]; then
  first_seq="$(echo "$sequences" | head -1)"
  last_seq="$(echo "$sequences" | tail -1)"
  expected_count=$(( last_seq - first_seq + 1 ))
  if [[ "$expected_count" -eq "$event_count" ]]; then
    pass "no gaps in sequence numbers ($first_seq to $last_seq)"
  else
    fail "gaps detected: expected $expected_count files from $first_seq to $last_seq, got $event_count"
  fi
fi

# ===================================================================
echo ""
echo "=== Test 5: Flock timeout fallback -- orphan file is created ==="
# ===================================================================
SESSION_5="test-session-005"
SANITIZED_5="$(gc_sanitize_session_id "$SESSION_5")"
SESSION_DIR_5="$CLAUDE_CONTEXT_PATH/events/$PROJECT_ID/$SANITIZED_5"

# Ensure the session directory and lock file exist
gc_ensure_session_dir "$PROJECT_ID" "$SANITIZED_5" >/dev/null

# Hold the lock in a background process for longer than the 5s timeout
(
  exec 9>"$SESSION_DIR_5/.lock"
  flock 9
  sleep 10
  exec 9>&-
) &
holder_pid=$!

# Give the holder time to acquire the lock
sleep 0.5

# Now try to write -- should timeout and produce an orphan
orphan_result="$(gc_write_event "$SESSION_5" "OrphanEvent" '{"test": "orphan"}' 2>/dev/null || true)"

# Kill the lock holder
kill "$holder_pid" 2>/dev/null || true
wait "$holder_pid" 2>/dev/null || true

if [[ -n "$orphan_result" && -f "$orphan_result" ]]; then
  orphan_basename="$(basename "$orphan_result")"
  if [[ "$orphan_basename" == orphan-*.json ]]; then
    pass "orphan file was created on flock timeout: $orphan_basename"
  else
    fail "expected orphan-*.json filename, got: $orphan_basename"
  fi
  # Verify the orphan file contains valid JSON with all 7 fields
  orphan_json="$(cat "$orphan_result")"
  if printf '%s' "$orphan_json" | jq empty 2>/dev/null; then
    pass "orphan file contains valid JSON"
  else
    fail "orphan file contains invalid JSON"
  fi
else
  fail "orphan file was not created (result: '$orphan_result')"
fi

# ===================================================================
echo ""
echo "=== Test 6: event_id is a valid UUID v4 format ==="
# ===================================================================
# Re-use session 1 files
all_uuid_valid=true
for i in $(seq 1 10); do
  padded="$(printf "%06d" "$i")"
  json="$(cat "$SESSION_DIR_1/${padded}.json")"
  eid="$(printf '%s' "$json" | jq -r '.event_id')"
  # UUID v4 format: 8-4-4-4-12 hex chars
  if [[ ! "$eid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    fail "event_id in ${padded}.json is not a valid UUID: $eid"
    all_uuid_valid=false
  fi
done

if [[ "$all_uuid_valid" == "true" ]]; then
  pass "all event_id values are valid UUIDs"
fi

# Also verify all UUIDs are unique
uuids=""
for i in $(seq 1 10); do
  padded="$(printf "%06d" "$i")"
  json="$(cat "$SESSION_DIR_1/${padded}.json")"
  eid="$(printf '%s' "$json" | jq -r '.event_id')"
  uuids="$uuids$eid"$'\n'
done
unique_uuids="$(echo "$uuids" | sort -u | grep -c . || true)"
if [[ "$unique_uuids" -eq 10 ]]; then
  pass "all 10 event_id values are unique"
else
  fail "expected 10 unique UUIDs, got $unique_uuids"
fi

# ===================================================================
echo ""
echo "=== Test 7: Timestamp is ISO 8601 UTC ==="
# ===================================================================
all_ts_valid=true
for i in $(seq 1 10); do
  padded="$(printf "%06d" "$i")"
  json="$(cat "$SESSION_DIR_1/${padded}.json")"
  ts="$(printf '%s' "$json" | jq -r '.timestamp')"
  # ISO 8601 UTC: YYYY-MM-DDTHH:MM:SS.mmmZ or YYYY-MM-DDTHH:MM:SSZ (fallback)
  if [[ ! "$ts" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$ ]]; then
    fail "timestamp in ${padded}.json is not ISO 8601 UTC: $ts"
    all_ts_valid=false
  fi
done

if [[ "$all_ts_valid" == "true" ]]; then
  pass "all timestamps are ISO 8601 UTC format"
fi

# ===================================================================
echo ""
echo "=== Test 8: Compact JSON (single line, no pretty-printing) ==="
# ===================================================================
all_compact=true
for i in $(seq 1 10); do
  padded="$(printf "%06d" "$i")"
  line_count="$(wc -l < "$SESSION_DIR_1/${padded}.json")"
  # A compact JSON file should be exactly 1 line (wc -l counts newlines; printf '%s' has 0)
  # Since gc_atomic_write uses printf '%s', there may be 0 trailing newlines
  if [[ "$line_count" -gt 1 ]]; then
    fail "file ${padded}.json is not compact JSON ($line_count lines)"
    all_compact=false
  fi
done

if [[ "$all_compact" == "true" ]]; then
  pass "all event files are compact JSON (single line)"
fi

# ===================================================================
echo ""
echo "=== Test 9: session.json exists and event_count matches ==="
# ===================================================================
if [[ -f "$SESSION_DIR_1/session.json" ]]; then
  pass "session.json exists after writing events"
else
  fail "session.json does not exist in $SESSION_DIR_1"
fi

session_json="$(cat "$SESSION_DIR_1/session.json")"
event_count_val="$(printf '%s' "$session_json" | jq '.event_count')"
if [[ "$event_count_val" == "10" ]]; then
  pass "session.json event_count is 10 after 10 events"
else
  fail "session.json event_count expected 10, got '$event_count_val'"
fi

# Verify session_id in session.json
sid_val="$(printf '%s' "$session_json" | jq -r '.session_id')"
if [[ "$sid_val" == "$SANITIZED_1" ]]; then
  pass "session.json session_id matches"
else
  fail "session.json session_id expected '$SANITIZED_1', got '$sid_val'"
fi

# Verify project_id in session.json
pid_val="$(printf '%s' "$session_json" | jq -r '.project_id')"
if [[ "$pid_val" == "$PROJECT_ID" ]]; then
  pass "session.json project_id matches"
else
  fail "session.json project_id expected '$PROJECT_ID', got '$pid_val'"
fi

# ===================================================================
echo ""
echo "=== Test 10: Event envelope fields have correct values ==="
# ===================================================================
# Check the first event file in detail
json1="$(cat "$SESSION_DIR_1/000001.json")"

val="$(printf '%s' "$json1" | jq -r '.event_type')"
if [[ "$val" == "TurnCompleted" ]]; then
  pass "event_type is correct"
else
  fail "event_type expected 'TurnCompleted', got '$val'"
fi

val="$(printf '%s' "$json1" | jq -r '.project_id')"
if [[ "$val" == "$PROJECT_ID" ]]; then
  pass "project_id in event envelope matches"
else
  fail "project_id expected '$PROJECT_ID', got '$val'"
fi

val="$(printf '%s' "$json1" | jq -r '.session_id')"
if [[ "$val" == "$SESSION_1" ]]; then
  pass "session_id in event envelope preserves original value"
else
  fail "session_id expected '$SESSION_1' (original), got '$val'"
fi

val="$(printf '%s' "$json1" | jq '.sequence')"
if [[ "$val" == "1" ]]; then
  pass "first event has sequence 1"
else
  fail "first event sequence expected 1, got '$val'"
fi

# Check data field
data_val="$(printf '%s' "$json1" | jq '.data.turn')"
if [[ "$data_val" == "1" ]]; then
  pass "data field contains correct content"
else
  fail "data.turn expected 1, got '$data_val'"
fi

# ===================================================================
echo ""
echo "=== Test 11: Writing to a new session starts at sequence 1 ==="
# ===================================================================
SESSION_11="brand-new-session"
result11="$(gc_write_event "$SESSION_11" "SessionStarted" '{"hello": "world"}')"
if [[ -f "$result11" ]]; then
  json11="$(cat "$result11")"
  seq11="$(printf '%s' "$json11" | jq '.sequence')"
  if [[ "$seq11" == "1" ]]; then
    pass "new session starts at sequence 1"
  else
    fail "new session sequence expected 1, got '$seq11'"
  fi
  basename11="$(basename "$result11")"
  if [[ "$basename11" == "000001.json" ]]; then
    pass "new session first file is 000001.json"
  else
    fail "new session first file expected 000001.json, got '$basename11'"
  fi
else
  fail "failed to write event to new session"
fi

# ===================================================================
echo ""
echo "=== Test 12: session.json is updated within flock scope ==="
# ===================================================================
# The session.json should have last_event_type matching the last event written
session_json_1="$(cat "$SESSION_DIR_1/session.json")"
let_val="$(printf '%s' "$session_json_1" | jq -r '.last_event_type')"
if [[ "$let_val" == "TurnCompleted" ]]; then
  pass "session.json last_event_type matches last event"
else
  fail "session.json last_event_type expected 'TurnCompleted', got '$let_val'"
fi

# last_event_at should be a valid ISO 8601 timestamp
lea_val="$(printf '%s' "$session_json_1" | jq -r '.last_event_at')"
if [[ "$lea_val" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]]; then
  pass "session.json last_event_at is ISO 8601"
else
  fail "session.json last_event_at is not ISO 8601: '$lea_val'"
fi

# ===================================================================
echo ""
echo "=== Test 13: Session ID sanitization is applied ==="
# ===================================================================
SESSION_13="ses..sion/with\\bad<chars>"
SANITIZED_13="$(gc_sanitize_session_id "$SESSION_13")"
result13="$(gc_write_event "$SESSION_13" "TestEvent" '{"sanitize": true}')"
if [[ -f "$result13" ]]; then
  json13="$(cat "$result13")"
  sid13="$(printf '%s' "$json13" | jq -r '.session_id')"
  # The envelope should preserve the original (unsanitized) session_id
  if [[ "$sid13" == "$SESSION_13" ]]; then
    pass "session_id preserves original value in event envelope"
  else
    fail "session_id expected original '$SESSION_13', got '$sid13'"
  fi
  # Verify the directory path uses the sanitized name
  if [[ "$result13" == *"/$SANITIZED_13/"* ]]; then
    pass "directory path uses sanitized session_id"
  else
    fail "directory path does not use sanitized session_id"
  fi
else
  fail "failed to write event with unsanitized session_id"
fi

# ===================================================================
echo ""
echo "=== Test 14: Zero-padded 6-digit sequence format ==="
# ===================================================================
# Check that single-digit sequences are properly padded
padded_check="$(basename "$(cat "$SESSION_DIR_1/000001.json" | jq -r '.sequence' | xargs printf "%06d")")"
# Already verified by filename existence, but let's double-check the format
for i in 1 5 10; do
  padded="$(printf "%06d" "$i")"
  if [[ -f "$SESSION_DIR_1/${padded}.json" ]]; then
    # Verify filename is exactly 6 digits + .json
    fname="$(basename "$SESSION_DIR_1/${padded}.json")"
    if [[ "$fname" =~ ^[0-9]{6}\.json$ ]]; then
      pass "file $fname has 6-digit zero-padded format"
    else
      fail "file $fname does not match 6-digit format"
    fi
  fi
done

# ===================================================================
echo ""
echo "================================="
echo "Results: $PASS passed, $FAIL failed"
echo "================================="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
