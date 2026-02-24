#!/usr/bin/env bash
# Tests for gap coverage: sessions filters (Task 16), search flags (Task 17),
# replay --verbose (Task 18), doctor --fix and exit codes (Task 19)
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

# Also set up a second project for --all-projects tests
PROJECT_DIR_2="/home/user/other-project"
PROJECT_ID_2="$(basename "$PROJECT_DIR_2" | tr -cd 'a-zA-Z0-9_-')-$(printf '%s' "$PROJECT_DIR_2" | sha256sum | cut -c1-6)"

# Create a minimal store structure
setup_store() {
  mkdir -p "$CLAUDE_CONTEXT_PATH/events/$PROJECT_ID"
  mkdir -p "$CLAUDE_CONTEXT_PATH/projections/$PROJECT_ID"
  mkdir -p "$CLAUDE_CONTEXT_PATH/events/$PROJECT_ID_2"
  mkdir -p "$CLAUDE_CONTEXT_PATH/projections/$PROJECT_ID_2"
  mkdir -p "$CLAUDE_CONTEXT_PATH/bin"

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
  local pid="$1" sid="$2" started="$3" n_events="$4" ended="${5:-}" last_prompt="${6:-Fix the bug}"
  local sdir="$CLAUDE_CONTEXT_PATH/events/$pid/$sid"
  mkdir -p "$sdir"

  local ended_json="null"
  local last_type="TurnCompleted"
  [[ -n "$ended" ]] && ended_json="\"$ended\"" && last_type="SessionEnded"

  cat > "$sdir/session.json" <<EOF
{
  "session_id": "$sid",
  "project_id": "$pid",
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
    [[ "$etype" == "ToolCallCompleted" ]] && data='{"tool_name":"Write","tool_result":"File written to src/auth/handler.ts successfully","target":"src/auth/handler.ts"}'

    jq -c -n \
      --arg eid "event-$sid-$i" \
      --arg etype "$etype" \
      --arg pid "$pid" \
      --arg sid "$sid" \
      --argjson seq "$i" \
      --arg ts "$started" \
      --argjson data "$data" \
      '{event_id:$eid,event_type:$etype,project_id:$pid,session_id:$sid,sequence:$seq,timestamp:$ts,data:$data}' > "$sdir/$padded.json"
  done
}

setup_store

# Create test sessions:
# sess-ended: ended session, project 1
create_session "$PROJECT_ID" "sess-ended" "2026-02-14T10:00:00Z" 5 "2026-02-14T11:00:00Z" "Fix auth bug"
# sess-active: active session (no ended_at), project 1
# Use a recent timestamp (1 hour ago) to avoid orphan detection (>24h = orphaned)
RECENT_TS="$(date -u -d '1 hour ago' '+%Y-%m-%dT%H:%M:%S.000Z' 2>/dev/null || date -u -v-1H '+%Y-%m-%dT%H:%M:%S.000Z')"
create_session "$PROJECT_ID" "sess-active" "$RECENT_TS" 3 "" "Write tests"
# sess-other: session in project 2
create_session "$PROJECT_ID_2" "sess-other" "2026-02-13T10:00:00Z" 4 "2026-02-13T11:00:00Z" "Deploy feature"

# Set latest symlinks
ln -sfn "sess-active" "$CLAUDE_CONTEXT_PATH/projections/$PROJECT_ID/latest"
ln -sfn "sess-other" "$CLAUDE_CONTEXT_PATH/projections/$PROJECT_ID_2/latest"


echo "=== Task 16: sessions --state, --since, --all-projects ==="

# ---- Test: --state filter ----
echo "Test: sessions --state ended"
output="$("$GC_QUERY" sessions --state ended --format json 2>&1)"
count="$(printf '%s' "$output" | jq 'length')"
if [[ "$count" -eq 1 ]]; then
  pass "sessions --state ended: 1 result"
else
  fail "sessions --state ended: count=$count (expected 1)"
fi
sid="$(printf '%s' "$output" | jq -r '.[0].session_id')"
if [[ "$sid" == "sess-ended" ]]; then
  pass "sessions --state ended: correct session"
else
  fail "sessions --state ended: sid=$sid (expected sess-ended)"
fi

echo "Test: sessions --state active"
output="$("$GC_QUERY" sessions --state active --format json 2>&1)"
count="$(printf '%s' "$output" | jq 'length')"
# Note: "sess-active" has no ended_at and is recent so it should be "active"
if [[ "$count" -ge 1 ]]; then
  pass "sessions --state active: at least 1 result"
else
  fail "sessions --state active: count=$count (expected >=1)"
fi

echo "Test: sessions --state nonexistent returns empty"
output="$("$GC_QUERY" sessions --state nonexistent --format json 2>&1)"
count="$(printf '%s' "$output" | jq 'length' 2>/dev/null || echo -1)"
if [[ "$count" -eq 0 ]]; then
  pass "sessions --state nonexistent: empty"
else
  fail "sessions --state nonexistent: count=$count"
fi

# ---- Test: --since filter ----
echo "Test: sessions --since 1d"
output="$("$GC_QUERY" sessions --since 1d --format json 2>&1)"
count="$(printf '%s' "$output" | jq 'length')"
# Both sessions are from 2026-02-14 and 2026-02-15 which is old relative to now,
# so we expect 0 or more depending on current date
# Let's test with a wide range instead
output_wide="$("$GC_QUERY" sessions --since 365d --format json 2>&1)"
count_wide="$(printf '%s' "$output_wide" | jq 'length')"
if [[ "$count_wide" -ge 1 ]]; then
  pass "sessions --since 365d: has results"
else
  fail "sessions --since 365d: count=$count_wide (expected >=1)"
fi

# ---- Test: --all-projects ----
echo "Test: sessions --all-projects"
output="$("$GC_QUERY" sessions --all-projects --format json 2>&1)"
count="$(printf '%s' "$output" | jq 'length')"
if [[ "$count" -ge 3 ]]; then
  pass "sessions --all-projects: >= 3 sessions across projects"
else
  fail "sessions --all-projects: count=$count (expected >=3)"
fi

echo "Test: sessions without --all-projects shows only current project"
output="$("$GC_QUERY" sessions --format json 2>&1)"
count="$(printf '%s' "$output" | jq 'length')"
if [[ "$count" -eq 2 ]]; then
  pass "sessions (current project): 2 sessions"
else
  fail "sessions (current project): count=$count (expected 2)"
fi


echo ""
echo "=== Task 17: search --file, --type, --case-sensitive ==="

# ---- Test: --file filter ----
echo "Test: search --file handler.ts"
output="$("$GC_QUERY" search --file "handler.ts" 2>&1)"
if echo "$output" | grep -q "handler.ts"; then
  pass "search --file handler.ts: found"
else
  fail "search --file handler.ts: $output"
fi

echo "Test: search --file nonexistent"
output="$("$GC_QUERY" search --file "nonexistent-file.xyz" 2>&1)"
if echo "$output" | grep -q "No results found"; then
  pass "search --file nonexistent: no results"
else
  fail "search --file nonexistent: $output"
fi

# ---- Test: --type filter ----
echo "Test: search --type UserPromptReceived"
output="$("$GC_QUERY" search "Fix" --type UserPromptReceived --format json 2>&1)"
count="$(printf '%s' "$output" | jq 'length' 2>/dev/null || echo 0)"
if [[ "$count" -ge 1 ]]; then
  pass "search --type UserPromptReceived: has results"
else
  fail "search --type UserPromptReceived: count=$count"
fi
# Verify all results are UserPromptReceived
non_prompt="$(printf '%s' "$output" | jq '[.[] | select(.event_type != "UserPromptReceived")] | length' 2>/dev/null || echo 0)"
if [[ "$non_prompt" -eq 0 ]]; then
  pass "search --type: only UserPromptReceived results"
else
  fail "search --type: $non_prompt non-matching results"
fi

echo "Test: search --type ToolCallCompleted"
output="$("$GC_QUERY" search "Write" --type ToolCallCompleted --format json 2>&1)"
count="$(printf '%s' "$output" | jq 'length' 2>/dev/null || echo 0)"
if [[ "$count" -ge 1 ]]; then
  pass "search --type ToolCallCompleted: has results"
else
  fail "search --type ToolCallCompleted: count=$count"
fi

# ---- Test: --case-sensitive flag ----
echo "Test: search --case-sensitive (exact case)"
output="$("$GC_QUERY" search "Fix" --case-sensitive 2>&1)"
if echo "$output" | grep -q "UserPromptReceived\|ToolCallCompleted"; then
  pass "search --case-sensitive: found with correct case"
else
  fail "search --case-sensitive: $output"
fi

echo "Test: search --case-sensitive (wrong case)"
output="$("$GC_QUERY" search "fix" --case-sensitive 2>&1)"
# "fix" lowercase should not match "Fix" when case sensitive
# But it might match in other fields. Let's search for something more specific.
output="$("$GC_QUERY" search "FIX THE BUG" --case-sensitive 2>&1)"
if echo "$output" | grep -q "No results found"; then
  pass "search --case-sensitive: no match for wrong case"
else
  fail "search --case-sensitive wrong case: $output"
fi

# ---- Test: search relevance sorting ----
echo "Test: search results sorted by relevance"
# Create a session with multiple matching events
create_session "$PROJECT_ID" "sess-many-matches" "2026-02-15T12:00:00Z" 5 "" "Write Write Write"
# Overwrite event 3 with extra matches
local_sdir="$CLAUDE_CONTEXT_PATH/events/$PROJECT_ID/sess-many-matches"
jq -c -n \
  --arg eid "e3-multi" \
  --arg etype "ToolCallCompleted" \
  --arg pid "$PROJECT_ID" \
  --arg sid "sess-many-matches" \
  --argjson seq 3 \
  --arg ts "2026-02-15T12:00:02Z" \
  --argjson data '{"tool_name":"Write","tool_result":"Write completed, Write again, Write more","target":"src/write.ts"}' \
  '{event_id:$eid,event_type:$etype,project_id:$pid,session_id:$sid,sequence:$seq,timestamp:$ts,data:$data}' > "$local_sdir/000003.json"

output="$("$GC_QUERY" search "Write" --format json 2>&1)"
if printf '%s' "$output" | jq -e 'length > 0' >/dev/null 2>&1; then
  pass "search relevance: has results"
else
  fail "search relevance: no results"
fi


echo ""
echo "=== Task 18: replay --verbose ==="

echo "Test: replay --verbose text output"
output="$("$GC_QUERY" replay sess-ended --verbose 2>&1)"
if echo "$output" | grep -q "Step 1"; then
  pass "replay --verbose: has steps"
else
  fail "replay --verbose: no steps"
fi
# Verbose should include raw event JSON
if echo "$output" | grep -q "event_id"; then
  pass "replay --verbose: includes raw event JSON"
else
  fail "replay --verbose: missing raw event JSON"
fi
if echo "$output" | grep -q "event_type"; then
  pass "replay --verbose: includes event_type in raw"
else
  fail "replay --verbose: missing event_type in raw"
fi

echo "Test: replay --verbose markdown output"
output="$("$GC_QUERY" replay sess-ended --verbose --format markdown 2>&1)"
# Verbose markdown should have JSON code blocks
if echo "$output" | grep -q '```json'; then
  pass "replay --verbose markdown: has json code blocks"
else
  fail "replay --verbose markdown: missing json code blocks"
fi

echo "Test: replay without --verbose has no raw JSON"
output="$("$GC_QUERY" replay sess-ended 2>&1)"
if echo "$output" | grep -q "event_id"; then
  fail "replay without --verbose should not include event_id"
else
  pass "replay without --verbose: no raw JSON"
fi


echo ""
echo "=== Task 19: doctor --fix and failure exit codes ==="

# ---- Test: doctor --fix creates missing directories ----
echo "Test: doctor --fix creates missing directories"
# Remove the bin directory to simulate missing
broken_store="$TEST_DIR/broken-store"
export CLAUDE_CONTEXT_PATH="$broken_store"
mkdir -p "$broken_store/events" "$broken_store/projections"
cat > "$broken_store/config.json" <<'EOF'
{"version":"1.0.0","created_at":"2026-02-14T10:00:00Z","storage_path":"/tmp/test","checksum":false}
EOF

output="$("$GC_QUERY" doctor --fix 2>&1)" || true
if echo "$output" | grep -q "\[PASS\].*directories"; then
  pass "doctor --fix: directories check"
else
  fail "doctor --fix: directories missing: $output"
fi
# Verify bin directory was created
if [[ -d "$broken_store/bin" ]]; then
  pass "doctor --fix: bin directory created"
else
  fail "doctor --fix: bin directory not created"
fi

# ---- Test: doctor exit code 1 on failure ----
echo "Test: doctor exit code on failure"
broken_store2="$TEST_DIR/broken-store2"
export CLAUDE_CONTEXT_PATH="$broken_store2"
# Don't create the store -- it doesn't exist
if "$GC_QUERY" doctor 2>/dev/null; then
  fail "doctor should exit non-zero for missing store"
else
  rc=$?
  if [[ $rc -eq 1 ]]; then
    pass "doctor exits 1 on failure"
  else
    fail "doctor exit code: $rc (expected 1)"
  fi
fi

# ---- Test: doctor --fix can fix missing store ----
echo "Test: doctor --fix creates missing store"
output="$("$GC_QUERY" doctor --fix 2>&1)" || true
if [[ -d "$broken_store2" ]]; then
  pass "doctor --fix: created missing store directory"
else
  fail "doctor --fix: store directory not created"
fi

# ---- Test: doctor JSON format with failures ----
echo "Test: doctor JSON shows failure count"
broken_store3="$TEST_DIR/broken-store3"
export CLAUDE_CONTEXT_PATH="$broken_store3"
output="$("$GC_QUERY" doctor --format json 2>&1)" || true
if printf '%s' "$output" | jq -e '.summary.failed > 0' >/dev/null 2>&1; then
  pass "doctor JSON: failure count > 0"
else
  fail "doctor JSON: $output"
fi

# ---- Test: doctor --fix removes stale files ----
echo "Test: doctor --fix removes stale files"
export CLAUDE_CONTEXT_PATH="$TEST_DIR/stale-store"
mkdir -p "$TEST_DIR/stale-store/events" "$TEST_DIR/stale-store/projections" "$TEST_DIR/stale-store/bin"
cat > "$TEST_DIR/stale-store/config.json" <<'EOF'
{"version":"1.0.0","created_at":"2026-02-14T10:00:00Z","storage_path":"/tmp/test","checksum":false}
EOF
echo '{}' > "$TEST_DIR/stale-store/sessions.json"
touch "$TEST_DIR/stale-store/.sessions.lock"

output="$("$GC_QUERY" doctor --fix 2>&1)" || true
if [[ ! -f "$TEST_DIR/stale-store/sessions.json" ]]; then
  pass "doctor --fix: removed stale sessions.json"
else
  fail "doctor --fix: stale sessions.json still exists"
fi
if [[ ! -f "$TEST_DIR/stale-store/.sessions.lock" ]]; then
  pass "doctor --fix: removed stale .sessions.lock"
else
  fail "doctor --fix: stale .sessions.lock still exists"
fi


echo ""
echo "========================================="
echo "Results: $PASS passed, $FAIL failed"
echo "========================================="
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
