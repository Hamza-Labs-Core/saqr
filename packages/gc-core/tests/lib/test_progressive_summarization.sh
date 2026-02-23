#!/usr/bin/env bash
# Tests for progressive summarization in format_context.sh (Task 10)
# and output truncation (Task 20)
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

echo "=== Testing Progressive Summarization ==="

# Helper to build a context JSON with N actions
build_context_with_actions() {
  local n="$1"
  local actions="["
  local i=0
  while [[ $i -lt $n ]]; do
    [[ $i -gt 0 ]] && actions="${actions},"
    local tool_names=("Write" "Read" "Bash" "Grep" "Edit")
    local tool="${tool_names[$((i % 5))]}"
    actions="${actions}{\"tool_name\":\"${tool}\",\"target\":\"src/file${i}.ts\",\"result_summary\":\"Result for action ${i}\"}"
    i=$((i + 1))
  done
  actions="${actions}]"

  jq -n \
    --argjson n "$n" \
    --argjson actions "$actions" \
    '{
      "_projection": "context",
      "_project_id": "proj-test",
      "_session_id": "sess-test",
      "_rebuilt_at": "2026-02-14T12:00:00Z",
      "_event_count": $n,
      "_last_sequence": $n,
      "data": {
        "session_id": "sess-test",
        "project_id": "proj-test",
        "started_at": "2026-02-14T10:00:00Z",
        "last_event_at": "2026-02-14T11:00:00Z",
        "event_count": $n,
        "last_prompt": "Fix the bugs",
        "ended_at": null,
        "previous_session_id": null,
        "actions": $actions,
        "files_modified": [],
        "decisions": []
      }
    }'
}

# ---- Test 1: Small action count (<=20) renders all in full detail ----
echo "Test 1: 10 actions - all full detail (markdown)"
ctx="$(build_context_with_actions 10)"
output="$(printf '%s' "$ctx" | format_markdown)"
# Should have action #1 with result_summary
if echo "$output" | grep -q "Result for action 0"; then
  pass "10 actions: first action has result_summary"
else
  fail "10 actions: missing result_summary for first action"
fi
# Should have action #10 with result_summary
if echo "$output" | grep -q "Result for action 9"; then
  pass "10 actions: last action has result_summary"
else
  fail "10 actions: missing result_summary for last action"
fi

# ---- Test 2: 30 actions - tier 2 (21-50 from end) ----
echo "Test 2: 30 actions - mixed tiers (markdown)"
ctx="$(build_context_with_actions 30)"
output="$(printf '%s' "$ctx" | format_markdown)"
# Actions 0-9 (indices 0-9, which are 21-30 from end) should be tier 2: no result_summary
if echo "$output" | grep -q "Result for action 0"; then
  fail "30 actions: tier 2 action should NOT have result_summary"
else
  pass "30 actions: tier 2 action lacks result_summary (correct)"
fi
# Actions 10-29 (last 20) should have full detail
if echo "$output" | grep -q "Result for action 29"; then
  pass "30 actions: tier 1 action has result_summary"
else
  fail "30 actions: tier 1 action missing result_summary"
fi

# ---- Test 3: 80 actions - tiers 2 and 3 ----
echo "Test 3: 80 actions - tiers 2, 3, and 1 (markdown)"
ctx="$(build_context_with_actions 80)"
output="$(printf '%s' "$ctx" | format_markdown)"
# Actions 0-29 (51-80 from end): tier 3 = grouped
if echo "$output" | grep -q "Grouped actions"; then
  pass "80 actions: tier 3 has grouped actions"
else
  fail "80 actions: missing grouped actions section"
fi
# Should see tool counts like "Write x6"
if echo "$output" | grep -q "x[0-9]"; then
  pass "80 actions: tier 3 shows tool counts"
else
  fail "80 actions: missing tool counts in tier 3"
fi
# Actions 60-79 (last 20): tier 1 = full detail
if echo "$output" | grep -q "Result for action 79"; then
  pass "80 actions: tier 1 has result_summary"
else
  fail "80 actions: tier 1 missing result_summary"
fi

# ---- Test 4: 150 actions - all four tiers ----
echo "Test 4: 150 actions - all four tiers (markdown)"
ctx="$(build_context_with_actions 150)"
output="$(printf '%s' "$ctx" | format_markdown)"
# Tier 4: one-line summary for actions 0-49 (50 events)
if echo "$output" | grep -q "50 events across"; then
  pass "150 actions: tier 4 one-line summary present"
else
  fail "150 actions: missing tier 4 summary"
fi
# Tier 3: grouped actions
if echo "$output" | grep -q "Grouped actions"; then
  pass "150 actions: tier 3 present"
else
  fail "150 actions: missing tier 3"
fi
# Tier 1: last 20 full detail
if echo "$output" | grep -q "Result for action 149"; then
  pass "150 actions: tier 1 last action has result"
else
  fail "150 actions: tier 1 missing"
fi

# ---- Test 5: Progressive summarization in text format ----
echo "Test 5: 150 actions - text format has summarization"
output="$(printf '%s' "$ctx" | format_text)"
if echo "$output" | grep -q "50 events across"; then
  pass "150 actions text: tier 4 present"
else
  fail "150 actions text: missing tier 4"
fi
if echo "$output" | grep -q "Grouped actions"; then
  pass "150 actions text: tier 3 present"
else
  fail "150 actions text: missing tier 3"
fi

# ---- Test 6: 20 actions boundary - all full detail ----
echo "Test 6: Exactly 20 actions - all full detail"
ctx="$(build_context_with_actions 20)"
output="$(printf '%s' "$ctx" | format_markdown)"
if echo "$output" | grep -q "Result for action 0"; then
  pass "20 actions: first has result (no summarization)"
else
  fail "20 actions: first missing result"
fi
if echo "$output" | grep -q "Result for action 19"; then
  pass "20 actions: last has result"
else
  fail "20 actions: last missing result"
fi

# ---- Test 7: 21 actions boundary - tier 2 kicks in ----
echo "Test 7: 21 actions - first is tier 2 (no result_summary)"
ctx="$(build_context_with_actions 21)"
output="$(printf '%s' "$ctx" | format_markdown)"
# Action 0 (21 from end) should be tier 2
if echo "$output" | grep -q "Result for action 0"; then
  fail "21 actions: action 0 should not have result_summary"
else
  pass "21 actions: action 0 is tier 2 (no result)"
fi

echo ""
echo "=== Testing Output Truncation ==="

# ---- Test 8: Small output is not truncated ----
echo "Test 8: Small output not truncated"
small_ctx="$(build_context_with_actions 5)"
output="$(printf '%s' "$small_ctx" | format_markdown)"
truncated="$(_gc_truncate_output "$output" 204800)"
if echo "$truncated" | grep -q "truncated"; then
  fail "Small output should not have truncation note"
else
  pass "Small output not truncated"
fi

# ---- Test 9: Large output is truncated ----
echo "Test 9: Large output truncated"
# Create output that exceeds a small limit
large_text="$(printf '%0.s=XXXXXXXXX' {1..500})"  # ~5000 chars
truncated="$(_gc_truncate_output "$large_text" 100)"
if echo "$truncated" | grep -q "Output truncated"; then
  pass "Large output has truncation note"
else
  fail "Large output missing truncation note: ${#truncated} bytes"
fi

# ---- Test 10: Long lines truncated to 200 chars ----
echo "Test 10: Long lines truncated"
long_line="$(printf '%0.s=' {1..300})"  # 300 chars
short_line="Short line"
input="${long_line}
${short_line}"
# Total input is ~311 bytes. Set limit to 300 so it triggers truncation.
# After truncation, 300-char line becomes 200 + "...(truncated)" = ~214, plus "Short line" = ~225
truncated="$(_gc_truncate_output "$input" 300)"
if echo "$truncated" | grep -q "(truncated)"; then
  pass "Long line has truncation marker"
else
  fail "Long line missing truncation marker"
fi
# Short line should remain since after line truncation total is within limit
if echo "$truncated" | grep -q "Short line"; then
  pass "Short line preserved"
else
  fail "Short line lost in truncation"
fi

echo ""
echo "========================================="
echo "Results: $PASS passed, $FAIL failed"
echo "========================================="
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
