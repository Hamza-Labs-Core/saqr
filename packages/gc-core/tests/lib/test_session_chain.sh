#!/usr/bin/env bash
# Tests for session_chain.sh (Task 13) and gc-hook (Tasks 14, 15)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GC_HOOK="$PROJECT_ROOT/src/bin/gc-hook"

TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

export CLAUDE_CONTEXT_PATH="$TEST_DIR/store"
mkdir -p "$CLAUDE_CONTEXT_PATH/events" "$CLAUDE_CONTEXT_PATH/projections" "$CLAUDE_CONTEXT_PATH/bin"

PASS=0; FAIL=0

pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1" >&2; }

source "$PROJECT_ROOT/src/lib/session_chain.sh"

pid="proj-test123"

# Create a chain: sess-003 -> sess-002 -> sess-001
create_chained_session() {
  local sid="$1" prev="$2" prompt="$3"
  local sdir="$CLAUDE_CONTEXT_PATH/events/$pid/$sid"
  mkdir -p "$sdir"
  local prev_json="null"
  [[ -n "$prev" ]] && prev_json="\"$prev\""
  cat > "$sdir/session.json" <<EOF
{"session_id":"$sid","project_id":"$pid","project_dir":"/home/test","started_at":"2026-02-14T10:00:00Z","source":"manual","model":"x","event_count":3,"last_event_at":"2026-02-14T10:30:00Z","last_event_type":"TurnCompleted","last_prompt":"$prompt","ended_at":null,"previous_session_id":$prev_json}
EOF
  for i in 1 2 3; do
    jq -c -n --arg eid "e$i" --arg etype "TurnCompleted" --arg pid "$pid" --arg sid "$sid" --argjson seq "$i" --arg ts "2026-02-14T10:00:00Z" --argjson data '{}' '{event_id:$eid,event_type:$etype,project_id:$pid,session_id:$sid,sequence:$seq,timestamp:$ts,data:$data}' > "$sdir/$(printf '%06d' $i).json"
  done
}

create_chained_session "sess-001" "" "First session prompt"
create_chained_session "sess-002" "sess-001" "Second session prompt"
create_chained_session "sess-003" "sess-002" "Third session prompt"

echo "=== Testing session_chain.sh ==="

# Test 1: Chain with no parent
echo "Test 1: Session with no parent"
output="$(resolve_session_chain "$pid" "sess-001" "markdown" 2>/dev/null)"
if echo "$output" | grep -q "Current Session: sess-001"; then
  pass "Current session shown"
else
  fail "No parent chain: $output"
fi

# Test 2: Chain of 3 sessions
echo "Test 2: Chain of 3"
output="$(resolve_session_chain "$pid" "sess-003" "markdown" 2>/dev/null)"
if echo "$output" | grep -q "Current Session: sess-003"; then pass "Chain current session"; else fail "Chain current: $output"; fi
if echo "$output" | grep -q "Parent Session: sess-002"; then pass "Chain parent session"; else fail "Chain parent: $output"; fi
if echo "$output" | grep -q "Ancestor.*sess-001"; then pass "Chain grandparent"; else fail "Chain grandparent: $output"; fi

# Test 3: JSON chain output
echo "Test 3: Chain JSON format"
output="$(resolve_session_chain "$pid" "sess-003" "json" 2>/dev/null)"
count="$(printf '%s' "$output" | jq 'length')"
if [[ "$count" -eq 3 ]]; then pass "JSON chain has 3 entries"; else fail "JSON chain count: $count"; fi

# Test 4: Circular chain detection
echo "Test 4: Circular chain"
# Create circular: A -> B -> A
mkdir -p "$CLAUDE_CONTEXT_PATH/events/$pid/circ-a" "$CLAUDE_CONTEXT_PATH/events/$pid/circ-b"
cat > "$CLAUDE_CONTEXT_PATH/events/$pid/circ-a/session.json" <<EOF
{"session_id":"circ-a","project_id":"$pid","project_dir":"/test","started_at":"2026-02-14T10:00:00Z","source":"manual","model":"x","event_count":1,"last_event_at":"2026-02-14T10:00:00Z","last_event_type":"Test","last_prompt":"test","ended_at":null,"previous_session_id":"circ-b"}
EOF
cat > "$CLAUDE_CONTEXT_PATH/events/$pid/circ-b/session.json" <<EOF
{"session_id":"circ-b","project_id":"$pid","project_dir":"/test","started_at":"2026-02-14T10:00:00Z","source":"manual","model":"x","event_count":1,"last_event_at":"2026-02-14T10:00:00Z","last_event_type":"Test","last_prompt":"test","ended_at":null,"previous_session_id":"circ-a"}
EOF
for s in circ-a circ-b; do
  jq -c -n --arg eid "e1" --arg etype "Test" --arg pid "$pid" --arg sid "$s" --argjson seq 1 --arg ts "2026-02-14T10:00:00Z" --argjson data '{}' '{event_id:$eid,event_type:$etype,project_id:$pid,session_id:$sid,sequence:$seq,timestamp:$ts,data:$data}' > "$CLAUDE_CONTEXT_PATH/events/$pid/$s/000001.json"
done
output="$(resolve_session_chain "$pid" "circ-a" "markdown" 2>/dev/null)"
if echo "$output" | grep -q "Circular chain detected"; then
  pass "Circular chain detected"
else
  fail "Circular chain not detected: $output"
fi

echo ""
echo "=== Testing gc-hook ==="

# Test 5: PreCompact hook builds projection
echo "Test 5: PreCompact hook"
"$GC_HOOK" precompact "$pid" "sess-001" 2>/dev/null || true
if [[ -f "$CLAUDE_CONTEXT_PATH/projections/$pid/sess-001/context.json" ]]; then
  pass "PreCompact builds projection"
else
  fail "PreCompact did not build projection"
fi

# Test 6: SessionStart manual returns empty JSON
echo "Test 6: SessionStart manual"
output="$("$GC_HOOK" sessionstart "$pid" "new-sess" "manual" 2>/dev/null)"
if printf '%s' "$output" | jq -e '. == {}' >/dev/null 2>&1; then
  pass "SessionStart manual returns {}"
else
  fail "SessionStart manual: $output"
fi

# Test 7: SessionStart compact returns additionalContext
echo "Test 7: SessionStart compact"
# Set up latest symlink
mkdir -p "$CLAUDE_CONTEXT_PATH/projections/$pid"
ln -sfn "sess-001" "$CLAUDE_CONTEXT_PATH/projections/$pid/latest"
output="$("$GC_HOOK" sessionstart "$pid" "new-sess" "compact" "sess-001" 2>/dev/null)"
if printf '%s' "$output" | jq -e '.additionalContext' >/dev/null 2>&1; then
  pass "SessionStart compact has additionalContext"
else
  fail "SessionStart compact: $output"
fi

# Test 8: PreCompact hook handles failure gracefully
echo "Test 8: PreCompact with bad args"
rc=0
"$GC_HOOK" precompact "" "" 2>/dev/null || rc=$?
if [[ $rc -eq 0 ]]; then pass "PreCompact bad args exits 0"; else fail "PreCompact bad args exit: $rc"; fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
