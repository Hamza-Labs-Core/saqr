#!/usr/bin/env bash
# Tests for context_loader.sh (Task 09) and format_context.sh (Task 10)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

export CLAUDE_CONTEXT_PATH="$TEST_DIR/store"
mkdir -p "$CLAUDE_CONTEXT_PATH/events" "$CLAUDE_CONTEXT_PATH/projections" "$CLAUDE_CONTEXT_PATH/bin"

PASS=0; FAIL=0

pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1" >&2; }

source "$PROJECT_ROOT/src/lib/context_loader.sh"
source "$PROJECT_ROOT/src/lib/format_context.sh"

pid="proj-test123"; sid="sess-001"

# Create events
mkdir -p "$CLAUDE_CONTEXT_PATH/events/$pid/$sid"
for i in 1 2 3; do
  local_etype="TurnCompleted"
  local_data='{}'
  [[ $i -eq 1 ]] && local_etype="SessionStarted" && local_data='{"cwd":"/home/test","source":"manual"}'
  [[ $i -eq 2 ]] && local_etype="UserPromptReceived" && local_data='{"prompt":"Fix the auth bug"}'
  jq -c -n --arg eid "e$i" --arg etype "$local_etype" --arg pid "$pid" --arg sid "$sid" --argjson seq "$i" --arg ts "2026-02-14T10:00:00Z" --argjson data "$local_data" '{event_id:$eid,event_type:$etype,project_id:$pid,session_id:$sid,sequence:$seq,timestamp:$ts,data:$data}' > "$CLAUDE_CONTEXT_PATH/events/$pid/$sid/$(printf '%06d' $i).json"
done
cat > "$CLAUDE_CONTEXT_PATH/events/$pid/$sid/session.json" <<EOF
{"session_id":"$sid","project_id":"$pid","project_dir":"/home/test","started_at":"2026-02-14T10:00:00Z","source":"manual","model":"x","event_count":3,"last_event_at":"2026-02-14T10:00:00Z","last_event_type":"TurnCompleted","last_prompt":"Fix the auth bug","ended_at":null,"previous_session_id":null}
EOF

echo "=== Testing context_loader.sh ==="

# Test 1: load_context builds degraded context (no project CLI)
echo "Test 1: Load context (degraded, no project CLI)"
result="$(load_context "$pid" "$sid")"
if printf '%s' "$result" | jq -e '.data.session_id' >/dev/null 2>&1; then
  pass "Degraded context has session_id"
else
  fail "Degraded context: $result"
fi

# Test 2: Degraded context has event_count
echo "Test 2: Degraded context event_count"
ec="$(printf '%s' "$result" | jq -r '.data.event_count // ._event_count')"
if [[ "$ec" -ge 3 ]]; then pass "Event count >= 3"; else fail "Event count: $ec"; fi

# Test 3: After build, projection file exists
echo "Test 3: Projection file created after build"
if [[ -f "$CLAUDE_CONTEXT_PATH/projections/$pid/$sid/context.json" ]]; then
  pass "Projection file exists"
else
  fail "Projection file not created"
fi

# Test 4: Second load reads from cache
echo "Test 4: Second load reads cache"
result2="$(load_context "$pid" "$sid")"
if printf '%s' "$result2" | jq -e '._projection == "context"' >/dev/null 2>&1; then
  pass "Second load reads cached projection"
else
  fail "Cache read: $result2"
fi

echo ""
echo "=== Testing format_context.sh ==="

# Create a rich context for formatting tests
context_json='{"_projection":"context","_project_id":"proj-test","_session_id":"sess-001","_rebuilt_at":"2026-02-14T12:00:00Z","_event_count":10,"_last_sequence":10,"data":{"session_id":"sess-001","project_id":"proj-test","started_at":"2026-02-14T10:00:00Z","last_event_at":"2026-02-14T11:00:00Z","event_count":10,"last_prompt":"Fix the auth bug in handler.ts","ended_at":null,"previous_session_id":null,"actions":[{"tool_name":"Write","target":"src/main.ts","result_summary":"File written"},{"tool_name":"Read","target":"src/auth.ts","result_summary":"File read"}],"files_modified":[{"path":"src/main.ts","operations":"write","last_action":"created"}],"decisions":["Use JWT tokens for auth","Add rate limiting"]}}'

# Test 5: format_json
echo "Test 5: format_json"
output="$(printf '%s' "$context_json" | format_json)"
if printf '%s' "$output" | jq -e '._projection == "context"' >/dev/null 2>&1; then
  pass "format_json valid"
else
  fail "format_json: $output"
fi

# Test 6: format_markdown sections
echo "Test 6: format_markdown has all sections"
md_output="$(printf '%s' "$context_json" | format_markdown)"
sections_ok=true
for section in "## Session Info" "## What Was Being Worked On" "## Actions Taken" "## Files Modified" "## Key Decisions" "## Where We Left Off"; do
  if ! echo "$md_output" | grep -q "$section"; then
    sections_ok=false
    fail "Missing section: $section"
  fi
done
[[ "$sections_ok" == "true" ]] && pass "All 6 markdown sections present"

# Test 7: Markdown has backtick file paths
echo "Test 7: Markdown backtick formatting"
if echo "$md_output" | grep -q '`src/main.ts`'; then
  pass "Backtick file paths"
else
  fail "Backtick paths missing"
fi

# Test 8: Markdown has blockquote prompt
echo "Test 8: Markdown blockquote prompt"
if echo "$md_output" | grep -q '> Fix the auth bug'; then
  pass "Blockquote prompt"
else
  fail "Blockquote missing"
fi

# Test 9: format_text
echo "Test 9: format_text output"
text_output="$(printf '%s' "$context_json" | format_text)"
if echo "$text_output" | grep -q "Session: sess-001"; then
  pass "Text has session info"
else
  fail "Text output: $text_output"
fi

# Test 10: format_compact
echo "Test 10: format_compact output"
compact_output="$(printf '%s' "$context_json" | format_compact)"
if echo "$compact_output" | grep -q "|.*|.*|"; then
  pass "Compact has pipe-separated fields"
else
  fail "Compact: $compact_output"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
