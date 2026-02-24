#!/usr/bin/env bash
# Tests for gc-query store-size subcommand (Task 03/13)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GC_QUERY="$PROJECT_ROOT/src/bin/gc-query"

# Temp directory for test store, cleaned up on exit
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

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

# Helper: create a session directory with session.json and event files
# Usage: create_session project_id session_id started_at num_events [event_size]
create_session() {
  local project_id="$1"
  local session_id="$2"
  local started_at="$3"
  local num_events="$4"
  local event_size="${5:-100}"

  local base_dir="${CLAUDE_CONTEXT_PATH:-$TEST_DIR/store}"
  local session_dir="$base_dir/events/$project_id/$session_id"
  mkdir -p "$session_dir"

  # Create session.json (per-session metadata)
  local session_json
  session_json=$(jq -n \
    --arg sid "$session_id" \
    --arg pid "$project_id" \
    --arg sat "$started_at" \
    '{
      session_id: $sid,
      project_id: $pid,
      project_dir: "/home/user/project",
      started_at: $sat,
      source: "manual",
      model: "claude-opus-4-6",
      event_count: 1,
      last_event_at: $sat,
      last_event_type: "SessionStarted",
      last_prompt: null,
      ended_at: null,
      previous_session_id: null
    }')
  printf '%s' "$session_json" > "$session_dir/session.json"

  # Create numbered event files (e.g., 001.json, 002.json)
  for i in $(seq 1 "$num_events"); do
    local padded
    padded=$(printf '%03d' "$i")
    # Create event file with approximately event_size bytes
    local event_json
    event_json=$(jq -n \
      --arg seq "$i" \
      --arg ts "$started_at" \
      --arg type "TestEvent" \
      '{
        sequence: ($seq | tonumber),
        timestamp: $ts,
        type: $type,
        data: {}
      }')
    printf '%s' "$event_json" > "$session_dir/${padded}.json"
  done
}

# ===================================================================
echo "=== Test 1: Empty store -- reports 0 sessions, 0 events, 0 bytes ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/store-empty"
  mkdir -p "$CLAUDE_CONTEXT_PATH/events"

  output=$("$GC_QUERY" store-size)

  if echo "$output" | grep -q "Sessions:.*0"; then
    echo "  PASS: empty store shows 0 sessions"
  else
    echo "  FAIL: empty store should show 0 sessions, got: $output" >&2
    exit 1
  fi

  if echo "$output" | grep -q "Total events:.*0"; then
    echo "  PASS: empty store shows 0 events"
  else
    echo "  FAIL: empty store should show 0 events, got: $output" >&2
    exit 1
  fi

  if echo "$output" | grep -q "Total size:.*0 B"; then
    echo "  PASS: empty store shows 0 B size"
  else
    echo "  FAIL: empty store should show 0 B size, got: $output" >&2
    exit 1
  fi

  if echo "$output" | grep -q "Oldest:.*none"; then
    echo "  PASS: empty store shows no oldest session"
  else
    echo "  FAIL: empty store should show (none) for oldest, got: $output" >&2
    exit 1
  fi

  if echo "$output" | grep -q "Newest:.*none"; then
    echo "  PASS: empty store shows no newest session"
  else
    echo "  FAIL: empty store should show (none) for newest, got: $output" >&2
    exit 1
  fi
) && pass "empty store reports zeroes" || fail "empty store reports zeroes"

# ===================================================================
echo ""
echo "=== Test 2: Store with 3 sessions and known event counts ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/store"
  mkdir -p "$CLAUDE_CONTEXT_PATH/events"

  # Session 1: project-a, 20 events, started 2026-01-15
  create_session "projA-abc123" "sess-001" "2026-01-15T08:00:00Z" 20

  # Session 2: project-a, 15 events, started 2026-02-01
  create_session "projA-abc123" "sess-002" "2026-02-01T10:00:00Z" 15

  # Session 3: project-b, 15 events, started 2026-02-14
  create_session "projB-def456" "sess-003" "2026-02-14T12:00:00Z" 15

  output=$("$GC_QUERY" store-size)

  # Should report 3 sessions
  if echo "$output" | grep -q "Sessions:.*3"; then
    echo "  PASS: reports 3 sessions"
  else
    echo "  FAIL: expected 3 sessions, got: $output" >&2
    exit 1
  fi

  # Should report 50 total events (20 + 15 + 15)
  if echo "$output" | grep -q "Total events:.*50"; then
    echo "  PASS: reports 50 total events"
  else
    echo "  FAIL: expected 50 total events, got: $output" >&2
    exit 1
  fi

  # Total size should be > 0
  if echo "$output" | grep -qE "Total size:.*[1-9]"; then
    echo "  PASS: total size is non-zero"
  else
    echo "  FAIL: expected non-zero total size, got: $output" >&2
    exit 1
  fi
) && pass "3 sessions with correct counts" || fail "3 sessions with correct counts"

# ===================================================================
echo ""
echo "=== Test 3: --format json produces valid JSON ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/store"

  output=$("$GC_QUERY" store-size --format json)

  # Must be valid JSON
  if printf '%s' "$output" | jq empty 2>/dev/null; then
    echo "  PASS: output is valid JSON"
  else
    echo "  FAIL: output is not valid JSON: $output" >&2
    exit 1
  fi

  # Check required fields exist
  for field in store_path session_count total_events total_size_bytes oldest_session newest_session; do
    if printf '%s' "$output" | jq -e "has(\"$field\")" >/dev/null 2>&1; then
      echo "  PASS: JSON has field '$field'"
    else
      echo "  FAIL: JSON missing field '$field'" >&2
      exit 1
    fi
  done

  # Check session_count is 3
  val=$(printf '%s' "$output" | jq '.session_count')
  if [[ "$val" == "3" ]]; then
    echo "  PASS: JSON session_count is 3"
  else
    echo "  FAIL: JSON session_count expected 3, got $val" >&2
    exit 1
  fi

  # Check total_events is 50
  val=$(printf '%s' "$output" | jq '.total_events')
  if [[ "$val" == "50" ]]; then
    echo "  PASS: JSON total_events is 50"
  else
    echo "  FAIL: JSON total_events expected 50, got $val" >&2
    exit 1
  fi

  # Check total_size_bytes is a number > 0
  val=$(printf '%s' "$output" | jq '.total_size_bytes')
  if [[ "$val" -gt 0 ]]; then
    echo "  PASS: JSON total_size_bytes is > 0"
  else
    echo "  FAIL: JSON total_size_bytes expected > 0, got $val" >&2
    exit 1
  fi
) && pass "--format json produces valid JSON with correct fields" || fail "--format json produces valid JSON with correct fields"

# ===================================================================
echo ""
echo "=== Test 4: --format text (default) produces human-readable output ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/store"

  output=$("$GC_QUERY" store-size)

  # Check the header line
  if echo "$output" | grep -q "^GlobalContext Store:"; then
    echo "  PASS: text output starts with GlobalContext Store header"
  else
    echo "  FAIL: text output missing header, got: $output" >&2
    exit 1
  fi

  # Check Sessions line format
  if echo "$output" | grep -q "^Sessions:"; then
    echo "  PASS: text output has Sessions line"
  else
    echo "  FAIL: text output missing Sessions line" >&2
    exit 1
  fi

  # Check Total events line format
  if echo "$output" | grep -q "^Total events:"; then
    echo "  PASS: text output has Total events line"
  else
    echo "  FAIL: text output missing Total events line" >&2
    exit 1
  fi

  # Check Total size line format
  if echo "$output" | grep -q "^Total size:"; then
    echo "  PASS: text output has Total size line"
  else
    echo "  FAIL: text output missing Total size line" >&2
    exit 1
  fi

  # Check Oldest line format
  if echo "$output" | grep -q "^Oldest:"; then
    echo "  PASS: text output has Oldest line"
  else
    echo "  FAIL: text output missing Oldest line" >&2
    exit 1
  fi

  # Check Newest line format
  if echo "$output" | grep -q "^Newest:"; then
    echo "  PASS: text output has Newest line"
  else
    echo "  FAIL: text output missing Newest line" >&2
    exit 1
  fi

  # Default format should be text (no --format flag)
  output_explicit=$("$GC_QUERY" store-size --format text)
  if [[ "$output" == "$output_explicit" ]]; then
    echo "  PASS: default format matches --format text"
  else
    echo "  FAIL: default format differs from --format text" >&2
    exit 1
  fi
) && pass "text output is human-readable with correct format" || fail "text output is human-readable with correct format"

# ===================================================================
echo ""
echo "=== Test 5: Oldest and newest session IDs are correct ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/store"

  # JSON mode to easily extract values
  output=$("$GC_QUERY" store-size --format json)

  oldest_id=$(printf '%s' "$output" | jq -r '.oldest_session.session_id')
  oldest_ts=$(printf '%s' "$output" | jq -r '.oldest_session.started_at')

  newest_id=$(printf '%s' "$output" | jq -r '.newest_session.session_id')
  newest_ts=$(printf '%s' "$output" | jq -r '.newest_session.started_at')

  # Oldest should be sess-001 (2026-01-15)
  if [[ "$oldest_id" == "sess-001" ]]; then
    echo "  PASS: oldest session is sess-001"
  else
    echo "  FAIL: oldest session expected 'sess-001', got '$oldest_id'" >&2
    exit 1
  fi

  if [[ "$oldest_ts" == "2026-01-15T08:00:00Z" ]]; then
    echo "  PASS: oldest started_at is 2026-01-15T08:00:00Z"
  else
    echo "  FAIL: oldest started_at expected '2026-01-15T08:00:00Z', got '$oldest_ts'" >&2
    exit 1
  fi

  # Newest should be sess-003 (2026-02-14)
  if [[ "$newest_id" == "sess-003" ]]; then
    echo "  PASS: newest session is sess-003"
  else
    echo "  FAIL: newest session expected 'sess-003', got '$newest_id'" >&2
    exit 1
  fi

  if [[ "$newest_ts" == "2026-02-14T12:00:00Z" ]]; then
    echo "  PASS: newest started_at is 2026-02-14T12:00:00Z"
  else
    echo "  FAIL: newest started_at expected '2026-02-14T12:00:00Z', got '$newest_ts'" >&2
    exit 1
  fi

  # Also verify text mode shows correct oldest/newest
  text_output=$("$GC_QUERY" store-size --format text)

  if echo "$text_output" | grep -q "Oldest:.*2026-01-15.*(session sess-001)"; then
    echo "  PASS: text mode shows correct oldest"
  else
    echo "  FAIL: text mode oldest incorrect" >&2
    echo "  Got: $(echo "$text_output" | grep "Oldest:")" >&2
    exit 1
  fi

  if echo "$text_output" | grep -q "Newest:.*2026-02-14.*(session sess-003)"; then
    echo "  PASS: text mode shows correct newest"
  else
    echo "  FAIL: text mode newest incorrect" >&2
    echo "  Got: $(echo "$text_output" | grep "Newest:")" >&2
    exit 1
  fi
) && pass "oldest and newest session IDs correct" || fail "oldest and newest session IDs correct"

# ===================================================================
echo ""
echo "=== Test 6: Excludes non-event files (session.json, etc.) from count ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/store-exclude"
  mkdir -p "$CLAUDE_CONTEXT_PATH/events"

  create_session "projC-111111" "sess-100" "2026-02-10T10:00:00Z" 5

  session_dir="$CLAUDE_CONTEXT_PATH/events/projC-111111/sess-100"

  # Add non-event files that should be excluded
  echo '{"lock": true}' > "$session_dir/.lock"
  echo '{"rejected": true}' > "$session_dir/rejected-001.json"
  echo 'temp data' > "$session_dir/tmp-write.json"

  output=$("$GC_QUERY" store-size --format json)

  val=$(printf '%s' "$output" | jq '.total_events')
  if [[ "$val" == "5" ]]; then
    echo "  PASS: non-event files excluded from count (5 events)"
  else
    echo "  FAIL: expected 5 events (excluding non-event files), got $val" >&2
    exit 1
  fi
) && pass "non-event files excluded from count" || fail "non-event files excluded from count"

# ===================================================================
echo ""
echo "=== Test 7: Store path is correctly reported ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/store-path-test"
  mkdir -p "$CLAUDE_CONTEXT_PATH/events"

  output=$("$GC_QUERY" store-size --format json)
  store_path=$(printf '%s' "$output" | jq -r '.store_path')

  if [[ "$store_path" == "$CLAUDE_CONTEXT_PATH" ]]; then
    echo "  PASS: store_path matches CLAUDE_CONTEXT_PATH"
  else
    echo "  FAIL: store_path expected '$CLAUDE_CONTEXT_PATH', got '$store_path'" >&2
    exit 1
  fi

  # Also check text mode
  text_output=$("$GC_QUERY" store-size --format text)
  if echo "$text_output" | grep -q "GlobalContext Store: $CLAUDE_CONTEXT_PATH"; then
    echo "  PASS: text mode shows correct store path"
  else
    echo "  FAIL: text mode store path incorrect" >&2
    exit 1
  fi
) && pass "store path correctly reported" || fail "store path correctly reported"

# ===================================================================
echo ""
echo "=== Test 8: Invalid --format option shows error ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/store"

  set +e
  output=$("$GC_QUERY" store-size --format xml 2>&1)
  exit_code=$?
  set -e

  if [[ $exit_code -ne 0 ]]; then
    echo "  PASS: invalid format option exits non-zero"
  else
    echo "  FAIL: invalid format option should exit non-zero" >&2
    exit 1
  fi

  if echo "$output" | grep -qi "error"; then
    echo "  PASS: error message shown for invalid format"
  else
    echo "  FAIL: no error message for invalid format" >&2
    exit 1
  fi
) && pass "invalid --format shows error" || fail "invalid --format shows error"

# ===================================================================
echo ""
echo "=== Test 9: No subcommand shows usage and exits non-zero ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/store"

  set +e
  output=$("$GC_QUERY" 2>&1)
  exit_code=$?
  set -e

  if [[ $exit_code -ne 0 ]]; then
    echo "  PASS: no subcommand exits non-zero"
  else
    echo "  FAIL: no subcommand should exit non-zero" >&2
    exit 1
  fi

  if echo "$output" | grep -q "Usage:"; then
    echo "  PASS: usage message shown"
  else
    echo "  FAIL: usage message not shown" >&2
    exit 1
  fi
) && pass "no subcommand shows usage" || fail "no subcommand shows usage"

# ===================================================================
echo ""
echo "=== Test 10: Multiple projects scanned correctly ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/store-multi"
  mkdir -p "$CLAUDE_CONTEXT_PATH/events"

  # 3 projects, each with 1 session, different event counts
  create_session "proj1-aaa111" "sess-a" "2026-01-20T09:00:00Z" 10
  create_session "proj2-bbb222" "sess-b" "2026-01-25T14:00:00Z" 20
  create_session "proj3-ccc333" "sess-c" "2026-02-05T16:00:00Z" 30

  output=$("$GC_QUERY" store-size --format json)

  val=$(printf '%s' "$output" | jq '.session_count')
  if [[ "$val" == "3" ]]; then
    echo "  PASS: 3 sessions across 3 projects"
  else
    echo "  FAIL: expected 3 sessions, got $val" >&2
    exit 1
  fi

  val=$(printf '%s' "$output" | jq '.total_events')
  if [[ "$val" == "60" ]]; then
    echo "  PASS: 60 total events across 3 projects (10+20+30)"
  else
    echo "  FAIL: expected 60 total events, got $val" >&2
    exit 1
  fi
) && pass "multiple projects scanned correctly" || fail "multiple projects scanned correctly"

# ===================================================================
echo ""
echo "=== Test 11: Empty events directory (no projects) ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/store-noproj"
  mkdir -p "$CLAUDE_CONTEXT_PATH/events"

  output=$("$GC_QUERY" store-size --format json)

  val=$(printf '%s' "$output" | jq '.session_count')
  if [[ "$val" == "0" ]]; then
    echo "  PASS: 0 sessions when events dir is empty"
  else
    echo "  FAIL: expected 0 sessions, got $val" >&2
    exit 1
  fi

  val=$(printf '%s' "$output" | jq '.total_events')
  if [[ "$val" == "0" ]]; then
    echo "  PASS: 0 events when events dir is empty"
  else
    echo "  FAIL: expected 0 events, got $val" >&2
    exit 1
  fi

  val=$(printf '%s' "$output" | jq '.total_size_bytes')
  if [[ "$val" == "0" ]]; then
    echo "  PASS: 0 bytes when events dir is empty"
  else
    echo "  FAIL: expected 0 bytes, got $val" >&2
    exit 1
  fi

  val=$(printf '%s' "$output" | jq '.oldest_session')
  if [[ "$val" == "null" ]]; then
    echo "  PASS: oldest_session is null when no sessions"
  else
    echo "  FAIL: expected oldest_session null, got $val" >&2
    exit 1
  fi

  val=$(printf '%s' "$output" | jq '.newest_session')
  if [[ "$val" == "null" ]]; then
    echo "  PASS: newest_session is null when no sessions"
  else
    echo "  FAIL: expected newest_session null, got $val" >&2
    exit 1
  fi
) && pass "empty events directory handled correctly" || fail "empty events directory handled correctly"

# ===================================================================
echo ""
echo "=== Test 12: Size calculation is accurate ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/store-size-calc"
  mkdir -p "$CLAUDE_CONTEXT_PATH/events"

  create_session "projX-xxx999" "sess-x" "2026-02-10T10:00:00Z" 3

  # Manually compute expected size by summing event file sizes
  session_dir="$CLAUDE_CONTEXT_PATH/events/projX-xxx999/sess-x"
  expected_size=0
  for f in "$session_dir"/[0-9]*.json; do
    fsize=$(stat -c '%s' "$f" 2>/dev/null || stat -f '%z' "$f" 2>/dev/null)
    expected_size=$((expected_size + fsize))
  done

  output=$("$GC_QUERY" store-size --format json)
  actual_size=$(printf '%s' "$output" | jq '.total_size_bytes')

  if [[ "$actual_size" == "$expected_size" ]]; then
    echo "  PASS: size calculation matches stat-based sum ($expected_size bytes)"
  else
    echo "  FAIL: expected $expected_size bytes, got $actual_size bytes" >&2
    exit 1
  fi
) && pass "size calculation is accurate" || fail "size calculation is accurate"

# ===================================================================
echo ""
echo "================================="
echo "Results: $PASS passed, $FAIL failed"
echo "================================="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
