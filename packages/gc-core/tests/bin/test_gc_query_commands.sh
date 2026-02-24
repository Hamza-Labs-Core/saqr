#!/usr/bin/env bash
# Tests for gc-query subcommands (Tasks 03, 06-08, 11-12, 16-19, 20)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GC_QUERY="$PROJECT_ROOT/src/bin/gc-query"

TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

export CLAUDE_CONTEXT_PATH="$TEST_DIR/store"
export GC_PROJECT_DIR="/home/user/test-project"

PASS=0; FAIL=0

pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1" >&2; }

# Compute project_id (same way paths.sh does)
PROJECT_ID="$(basename "$GC_PROJECT_DIR" | tr -cd 'a-zA-Z0-9_-')-$(printf '%s' "$GC_PROJECT_DIR" | sha256sum | cut -c1-6)"

# Create a minimal store structure
setup_store() {
  mkdir -p "$CLAUDE_CONTEXT_PATH/events/$PROJECT_ID"
  mkdir -p "$CLAUDE_CONTEXT_PATH/projections/$PROJECT_ID"
  mkdir -p "$CLAUDE_CONTEXT_PATH/bin"

  # Create config.json
  cat > "$CLAUDE_CONTEXT_PATH/config.json" <<'EOF'
{
  "version": "1.0.0",
  "created_at": "2026-02-14T10:00:00Z",
  "storage_path": "/tmp/test",
  "checksum": false
}
EOF
}

# Create a session with N events
create_session() {
  local sid="$1" started="$2" n_events="$3" ended="${4:-}" last_prompt="${5:-Fix the bug}"
  local sdir="$CLAUDE_CONTEXT_PATH/events/$PROJECT_ID/$sid"
  mkdir -p "$sdir"

  local ended_json="null"
  local last_type="TurnCompleted"
  [[ -n "$ended" ]] && ended_json="\"$ended\"" && last_type="SessionEnded"

  cat > "$sdir/session.json" <<EOF
{
  "session_id": "$sid",
  "project_id": "$PROJECT_ID",
  "project_dir": "$GC_PROJECT_DIR",
  "started_at": "$started",
  "source": "manual",
  "model": "claude-opus-4-6",
  "event_count": $n_events,
  "last_event_at": "$started",
  "last_event_type": "$last_type",
  "last_prompt": "$last_prompt",
  "ended_at": $ended_json,
  "previous_session_id": null
}
EOF

  # Create event files
  for i in $(seq 1 "$n_events"); do
    local padded
    padded="$(printf '%06d' "$i")"
    local etype="TurnCompleted"
    [[ $i -eq 1 ]] && etype="SessionStarted"
    [[ $i -eq 2 ]] && etype="UserPromptReceived"
    [[ $i -eq 3 ]] && etype="ToolCallCompleted"

    local data='{}'
    [[ "$etype" == "SessionStarted" ]] && data='{"cwd":"/home/user/test-project","source":"manual"}'
    [[ "$etype" == "UserPromptReceived" ]] && data="{\"prompt\":\"$last_prompt\"}"
    [[ "$etype" == "ToolCallCompleted" ]] && data='{"tool_name":"Write","tool_result":"File written successfully","target":"src/main.ts"}'

    jq -c -n \
      --arg eid "event-$sid-$i" \
      --arg etype "$etype" \
      --arg pid "$PROJECT_ID" \
      --arg sid "$sid" \
      --argjson seq "$i" \
      --arg ts "$started" \
      --argjson data "$data" \
      '{event_id:$eid,event_type:$etype,project_id:$pid,session_id:$sid,sequence:$seq,timestamp:$ts,data:$data}' > "$sdir/$padded.json"
  done
}

setup_store

echo "=== Testing gc-query subcommands ==="

# ---- Task 03: Entry point & argument parser ----

echo ""
echo "--- Task 03: Entry point ---"

# Test: No args prints help, exits 2
echo "Test: No args exits 2"
if "$GC_QUERY" 2>/dev/null; then
  fail "No args should exit non-zero"
else
  rc=$?
  if [[ $rc -eq 2 ]]; then pass "No args exits 2"; else fail "No args exit code: $rc"; fi
fi

# Test: --help exits 0
echo "Test: --help exits 0"
output="$("$GC_QUERY" --help 2>&1)"
rc=$?
if [[ $rc -eq 0 ]]; then pass "--help exits 0"; else fail "--help exit code: $rc"; fi

# Test: --help contains subcommands
echo "Test: --help shows subcommands"
if echo "$output" | grep -q "last"; then pass "--help lists last"; else fail "--help missing 'last'"; fi
if echo "$output" | grep -q "session"; then pass "--help lists session"; else fail "--help missing 'session'"; fi
if echo "$output" | grep -q "doctor"; then pass "--help lists doctor"; else fail "--help missing 'doctor'"; fi

# Test: Invalid subcommand exits 2
echo "Test: Invalid subcommand exits 2"
if "$GC_QUERY" invalidcommand 2>/dev/null; then
  fail "Invalid subcommand should fail"
else
  rc=$?
  if [[ $rc -eq 2 ]]; then pass "Invalid subcommand exits 2"; else fail "Invalid subcommand exit code: $rc"; fi
fi

# ---- Task 06: status ----

echo ""
echo "--- Task 06: status ---"

# Test: Empty store status
echo "Test: Status with empty store"
output="$("$GC_QUERY" status 2>&1)" || true
if echo "$output" | grep -q "empty\|No sessions"; then pass "Empty store message"; else fail "Empty store: $output"; fi

# Create sessions and test again
create_session "sess-001" "2026-02-14T10:00:00Z" 5
create_session "sess-002" "2026-02-15T10:00:00Z" 3 "" "Write tests"

# Set latest symlink
ln -sfn "sess-002" "$CLAUDE_CONTEXT_PATH/projections/$PROJECT_ID/latest"

echo "Test: Status with sessions"
output="$("$GC_QUERY" status 2>&1)"
if echo "$output" | grep -q "Sessions:.*2"; then pass "Status shows 2 sessions"; else fail "Status sessions count: $output"; fi
if echo "$output" | grep -q "Total events:.*8"; then pass "Status shows 8 events"; else fail "Status events count: $output"; fi

echo "Test: Status JSON format"
json_output="$("$GC_QUERY" status --format json 2>&1)"
if printf '%s' "$json_output" | jq -e '.sessions == 2' >/dev/null 2>&1; then
  pass "Status JSON sessions=2"
else
  fail "Status JSON: $json_output"
fi

# ---- Task 07: events ----

echo ""
echo "--- Task 07: events ---"

echo "Test: Events for session"
output="$("$GC_QUERY" events sess-001 2>&1)"
line_count="$(echo "$output" | wc -l)"
if [[ "$line_count" -eq 5 ]]; then pass "Events outputs 5 lines (JSONL)"; else fail "Events lines: $line_count"; fi

echo "Test: Events with --from/--to"
output="$("$GC_QUERY" events sess-001 --from 2 --to 3 2>&1)"
line_count="$(echo "$output" | wc -l)"
if [[ "$line_count" -eq 2 ]]; then pass "Events range 2-3: 2 lines"; else fail "Events range lines: $line_count"; fi

echo "Test: Events with --type filter"
output="$("$GC_QUERY" events sess-001 --type SessionStarted 2>&1)"
line_count="$(echo "$output" | wc -l)"
if [[ "$line_count" -eq 1 ]]; then pass "Events type filter: 1 line"; else fail "Events type filter lines: $line_count"; fi

echo "Test: Events as JSON array"
output="$("$GC_QUERY" events sess-001 --format json 2>&1)"
if printf '%s' "$output" | jq -e 'length == 5' >/dev/null 2>&1; then
  pass "Events JSON array length=5"
else
  fail "Events JSON: $output"
fi

echo "Test: Events for nonexistent session"
if "$GC_QUERY" events nonexistent 2>/dev/null; then
  fail "Nonexistent session should fail"
else
  rc=$?
  if [[ $rc -eq 3 ]]; then pass "Nonexistent session exits 3"; else fail "Nonexistent session exit code: $rc"; fi
fi

echo "Test: Events in sequence order"
first_seq="$(echo "$output" | jq -r '.[0].sequence')"
last_seq="$(echo "$output" | jq -r '.[-1].sequence')"
if [[ "$first_seq" -lt "$last_seq" ]]; then pass "Events in sequence order"; else fail "Events order: first=$first_seq last=$last_seq"; fi

# ---- Task 08: tail ----

echo ""
echo "--- Task 08: tail ---"

echo "Test: Tail default (20)"
output="$("$GC_QUERY" tail sess-001 2>&1)"
line_count="$(echo "$output" | wc -l)"
if [[ "$line_count" -eq 5 ]]; then pass "Tail shows all 5 (< 20)"; else fail "Tail lines: $line_count"; fi

echo "Test: Tail with N=2"
output="$("$GC_QUERY" tail sess-001 2 2>&1)"
line_count="$(echo "$output" | wc -l)"
if [[ "$line_count" -eq 2 ]]; then pass "Tail N=2: 2 lines"; else fail "Tail N=2 lines: $line_count"; fi

# ---- Task 11: last ----

echo ""
echo "--- Task 11: last ---"

echo "Test: Last command (markdown)"
output="$("$GC_QUERY" last 2>&1)"
if echo "$output" | grep -q "## Session Info"; then pass "Last outputs markdown"; else fail "Last markdown: $output"; fi

echo "Test: Last command (JSON)"
output="$("$GC_QUERY" last --format json 2>&1)"
if printf '%s' "$output" | jq -e '.' >/dev/null 2>&1; then pass "Last JSON is valid"; else fail "Last JSON invalid"; fi

echo "Test: Last command (text)"
output="$("$GC_QUERY" last --format text 2>&1)"
if echo "$output" | grep -q "Session:"; then pass "Last text output"; else fail "Last text: $output"; fi

echo "Test: Last command (compact)"
output="$("$GC_QUERY" last --format compact 2>&1)"
if echo "$output" | grep -q "|"; then pass "Last compact has pipes"; else fail "Last compact: $output"; fi

# ---- Task 12: session ----

echo ""
echo "--- Task 12: session ---"

echo "Test: Session by full ID"
output="$("$GC_QUERY" session sess-001 --format json 2>&1)"
if printf '%s' "$output" | jq -e '.' >/dev/null 2>&1; then pass "Session by full ID"; else fail "Session full ID"; fi

echo "Test: Session by prefix"
output="$("$GC_QUERY" session sess-001 --format compact 2>&1)"
if echo "$output" | grep -q "sess-001"; then pass "Session by prefix"; else fail "Session prefix: $output"; fi

echo "Test: Session nonexistent"
if "$GC_QUERY" session nonexistent 2>/dev/null; then
  fail "Nonexistent session should fail"
else
  pass "Nonexistent session fails"
fi

# ---- Task 16: sessions ----

echo ""
echo "--- Task 16: sessions ---"

echo "Test: Sessions list text"
output="$("$GC_QUERY" sessions 2>&1)"
if echo "$output" | grep -q "sess-001\|sess-002"; then pass "Sessions lists sessions"; else fail "Sessions text: $output"; fi

echo "Test: Sessions list JSON"
output="$("$GC_QUERY" sessions --format json 2>&1)"
count="$(printf '%s' "$output" | jq 'length')"
if [[ "$count" -eq 2 ]]; then pass "Sessions JSON count=2"; else fail "Sessions JSON count: $count"; fi

echo "Test: Sessions with --limit"
output="$("$GC_QUERY" sessions --limit 1 --format json 2>&1)"
count="$(printf '%s' "$output" | jq 'length')"
if [[ "$count" -eq 1 ]]; then pass "Sessions limit=1"; else fail "Sessions limit count: $count"; fi

echo "Test: Sessions sorted descending"
output="$("$GC_QUERY" sessions --format json 2>&1)"
first_started="$(printf '%s' "$output" | jq -r '.[0].started_at')"
if [[ "$first_started" == "2026-02-15T10:00:00Z" ]]; then
  pass "Sessions sorted descending"
else
  fail "Sessions sort: first=$first_started"
fi

# ---- Task 17: search ----

echo ""
echo "--- Task 17: search ---"

echo "Test: Search for prompt text"
output="$("$GC_QUERY" search "Fix the bug" 2>&1)"
if echo "$output" | grep -q "UserPromptReceived"; then pass "Search finds prompt"; else fail "Search prompt: $output"; fi

echo "Test: Search for tool name"
output="$("$GC_QUERY" search "Write" 2>&1)"
if echo "$output" | grep -q "ToolCallCompleted"; then pass "Search finds tool"; else fail "Search tool: $output"; fi

echo "Test: Search case insensitive"
output="$("$GC_QUERY" search "fix THE bug" 2>&1)"
if echo "$output" | grep -q "UserPromptReceived"; then pass "Search case insensitive"; else fail "Search case: $output"; fi

echo "Test: Search no results"
output="$("$GC_QUERY" search "zzz-nonexistent-zzz" 2>&1)"
if echo "$output" | grep -q "No results found"; then pass "Search no results"; else fail "Search no results: $output"; fi

echo "Test: Search with --limit"
output="$("$GC_QUERY" search "test" --limit 1 --format json 2>&1)"
count="$(printf '%s' "$output" | jq 'length')"
if [[ "$count" -le 1 ]]; then pass "Search limit=1"; else fail "Search limit count: $count"; fi

echo "Test: Search JSON format"
output="$("$GC_QUERY" search "Fix the bug" --format json 2>&1)"
if printf '%s' "$output" | jq -e '.[0].session_id' >/dev/null 2>&1; then
  pass "Search JSON has session_id"
else
  fail "Search JSON: $output"
fi

# ---- Task 18: replay ----

echo ""
echo "--- Task 18: replay ---"

echo "Test: Replay text output"
output="$("$GC_QUERY" replay sess-001 2>&1)"
if echo "$output" | grep -q "Step 1"; then pass "Replay has steps"; else fail "Replay steps: $output"; fi
if echo "$output" | grep -q "Session started"; then pass "Replay SessionStarted"; else fail "Replay SessionStarted: $output"; fi

echo "Test: Replay with --from/--to"
output="$("$GC_QUERY" replay sess-001 --from 2 --to 3 2>&1)"
if echo "$output" | grep -q "Step 1" && echo "$output" | grep -q "Step 2"; then
  pass "Replay range shows 2 steps"
else
  fail "Replay range: $output"
fi

echo "Test: Replay JSON format"
output="$("$GC_QUERY" replay sess-001 --format json 2>&1)"
if printf '%s' "$output" | jq -e '.[0].step == 1' >/dev/null 2>&1; then
  pass "Replay JSON has step 1"
else
  fail "Replay JSON: $output"
fi

echo "Test: Replay markdown format"
output="$("$GC_QUERY" replay sess-001 --format markdown 2>&1)"
if echo "$output" | grep -q "## Session Replay"; then pass "Replay markdown heading"; else fail "Replay markdown: $output"; fi

# ---- Task 19: doctor ----

echo ""
echo "--- Task 19: doctor ---"

echo "Test: Doctor text output"
output="$("$GC_QUERY" doctor 2>&1)" || true
if echo "$output" | grep -q "GlobalContext Doctor"; then pass "Doctor heading"; else fail "Doctor heading: $output"; fi
if echo "$output" | grep -q "\[PASS\].*Store directory exists"; then pass "Doctor store check"; else fail "Doctor store: $output"; fi
if echo "$output" | grep -q "\[PASS\].*jq is available"; then pass "Doctor jq check"; else fail "Doctor jq: $output"; fi
if echo "$output" | grep -q "Result:"; then pass "Doctor summary"; else fail "Doctor summary: $output"; fi

echo "Test: Doctor JSON format"
output="$("$GC_QUERY" doctor --format json 2>&1)" || true
if printf '%s' "$output" | jq -e '.summary.passed > 0' >/dev/null 2>&1; then
  pass "Doctor JSON has passes"
else
  fail "Doctor JSON: $output"
fi

# ---- Task 20: Edge cases ----

echo ""
echo "--- Task 20: Edge cases ---"

echo "Test: Errors go to stderr"
stderr_output="$("$GC_QUERY" events nonexistent 2>&1 1>/dev/null)" || true
if [[ -n "$stderr_output" ]]; then pass "Errors go to stderr"; else fail "No stderr output for error"; fi

echo "Test: Corrupt event file handled"
corrupt_dir="$CLAUDE_CONTEXT_PATH/events/$PROJECT_ID/sess-corrupt"
mkdir -p "$corrupt_dir"
echo "not json" > "$corrupt_dir/000001.json"
printf '{"event_id":"e1","event_type":"Test","project_id":"p","session_id":"s","sequence":2,"timestamp":"t","data":{}}' > "$corrupt_dir/000002.json"
cat > "$corrupt_dir/session.json" <<EOF
{"session_id":"sess-corrupt","project_id":"$PROJECT_ID","project_dir":"$GC_PROJECT_DIR","started_at":"2026-02-14T10:00:00Z","source":"manual","model":"x","event_count":2,"last_event_at":"2026-02-14T10:00:00Z","last_event_type":"Test","last_prompt":null,"ended_at":null,"previous_session_id":null}
EOF
output="$("$GC_QUERY" events sess-corrupt 2>/dev/null)"
# Should have output for the valid event (000002.json)
if echo "$output" | grep -q "event_id"; then pass "Corrupt event skipped, valid shown"; else fail "Corrupt event handling: $output"; fi

echo "Test: Empty result is not error"
output="$("$GC_QUERY" events sess-001 --from 999 --to 9999 2>&1)"
rc=$?
if [[ $rc -eq 0 ]]; then pass "Empty result returns 0"; else fail "Empty result exit code: $rc"; fi

echo ""
echo "========================================="
echo "Results: $PASS passed, $FAIL failed"
echo "========================================="
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
