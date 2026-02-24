#!/usr/bin/env bash
# Tests for session_read.sh (Task 02)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

export CLAUDE_CONTEXT_PATH="$TEST_DIR/store"
mkdir -p "$CLAUDE_CONTEXT_PATH"

PASS=0; FAIL=0

pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1" >&2; }

# Source the library
source "$PROJECT_ROOT/src/lib/session_read.sh"

# Helper to create a test session
create_test_session() {
  local pid="$1" sid="$2" started="$3" last_event="$4" ended="${5:-null}" last_type="${6:-TurnCompleted}"
  local sdir="$CLAUDE_CONTEXT_PATH/events/$pid/$sid"
  mkdir -p "$sdir"
  local ended_json="null"
  [[ "$ended" != "null" ]] && ended_json="\"$ended\""
  cat > "$sdir/session.json" <<EOF
{
  "session_id": "$sid",
  "project_id": "$pid",
  "project_dir": "/home/user/project",
  "started_at": "$started",
  "source": "manual",
  "model": "claude-opus-4-6",
  "event_count": 5,
  "last_event_at": "$last_event",
  "last_event_type": "$last_type",
  "last_prompt": "Fix the auth bug",
  "ended_at": $ended_json,
  "previous_session_id": null
}
EOF
}

echo "=== Testing session_read.sh ==="

# Test 1: Read session with ended_at -> state=ended
echo "Test 1: Ended session state"
create_test_session "proj-abc123" "sess-001" "2026-02-14T10:00:00Z" "2026-02-14T11:30:00Z" "2026-02-14T11:30:00Z"
result="$(gc_read_session_with_derived "proj-abc123" "sess-001")"
state="$(printf '%s' "$result" | jq -r '.state')"
if [[ "$state" == "ended" ]]; then pass "Ended session state"; else fail "Ended session state: got $state"; fi

# Test 2: Duration calculation
echo "Test 2: Duration calculation"
dur="$(printf '%s' "$result" | jq -r '.duration_seconds')"
if [[ "$dur" == "5400" ]]; then pass "Duration = 5400 seconds"; else fail "Duration: expected 5400, got $dur"; fi

# Test 3: Active session
echo "Test 3: Active session state"
recent="$(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-5M +%Y-%m-%dT%H:%M:%SZ)"
create_test_session "proj-abc123" "sess-002" "$recent" "$recent"
result2="$(gc_read_session_with_derived "proj-abc123" "sess-002")"
state2="$(printf '%s' "$result2" | jq -r '.state')"
if [[ "$state2" == "active" ]]; then pass "Active session state"; else fail "Active session state: got $state2"; fi

# Test 4: Compacted session
echo "Test 4: Compacted session state"
create_test_session "proj-abc123" "sess-003" "2026-02-14T10:00:00Z" "2026-02-14T10:30:00Z" "null" "CompactionTriggered"
result3="$(gc_read_session_with_derived "proj-abc123" "sess-003")"
state3="$(printf '%s' "$result3" | jq -r '.state')"
if [[ "$state3" == "compacted" ]]; then pass "Compacted session state"; else fail "Compacted session state: got $state3"; fi

# Test 5: Orphaned session (no events for 24h+)
echo "Test 5: Orphaned session state"
old_time="2025-01-01T10:00:00Z"
create_test_session "proj-abc123" "sess-004" "$old_time" "$old_time"
result4="$(gc_read_session_with_derived "proj-abc123" "sess-004")"
state4="$(printf '%s' "$result4" | jq -r '.state')"
if [[ "$state4" == "orphaned" ]]; then pass "Orphaned session state"; else fail "Orphaned session state: got $state4"; fi

# Test 6: Missing session.json returns error
echo "Test 6: Missing session.json"
if gc_read_session_with_derived "proj-abc123" "nonexistent" 2>/dev/null; then
  fail "Should fail for missing session"
else
  pass "Error for missing session"
fi

# Test 7: All base fields preserved
echo "Test 7: Base fields preserved"
sid_check="$(printf '%s' "$result" | jq -r '.session_id')"
pid_check="$(printf '%s' "$result" | jq -r '.project_id')"
if [[ "$sid_check" == "sess-001" && "$pid_check" == "proj-abc123" ]]; then
  pass "Base fields preserved"
else
  fail "Base fields: sid=$sid_check pid=$pid_check"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
