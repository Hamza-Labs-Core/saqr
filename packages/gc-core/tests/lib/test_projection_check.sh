#!/usr/bin/env bash
# Tests for projection_check.sh (Task 04)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

export CLAUDE_CONTEXT_PATH="$TEST_DIR/store"
mkdir -p "$CLAUDE_CONTEXT_PATH/events" "$CLAUDE_CONTEXT_PATH/projections"

PASS=0; FAIL=0

pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1" >&2; }

source "$PROJECT_ROOT/src/lib/projection_check.sh"

echo "=== Testing projection_check.sh ==="

# Test 1: Current projection (sequence matches)
echo "Test 1: Current projection"
pid="proj-abc123"; sid="sess-001"
mkdir -p "$CLAUDE_CONTEXT_PATH/events/$pid/$sid"
mkdir -p "$CLAUDE_CONTEXT_PATH/projections/$pid/$sid"
for i in $(seq 1 50); do
  printf '{"event_id":"e%d","event_type":"Test","project_id":"%s","session_id":"%s","sequence":%d,"timestamp":"2026-02-14T10:00:00Z","data":{}}' "$i" "$pid" "$sid" "$i" > "$CLAUDE_CONTEXT_PATH/events/$pid/$sid/$(printf '%06d' $i).json"
done
printf '{"_projection":"context","_last_sequence":50,"data":{}}' > "$CLAUDE_CONTEXT_PATH/projections/$pid/$sid/context.json"
if is_projection_current "$pid" "$sid" "context"; then
  pass "Current projection returns 0"
else
  fail "Current projection should return 0"
fi

# Test 2: Stale projection (more events than projection knows about)
echo "Test 2: Stale projection"
for i in $(seq 51 55); do
  printf '{"event_id":"e%d","event_type":"Test","project_id":"%s","session_id":"%s","sequence":%d,"timestamp":"2026-02-14T10:00:00Z","data":{}}' "$i" "$pid" "$sid" "$i" > "$CLAUDE_CONTEXT_PATH/events/$pid/$sid/$(printf '%06d' $i).json"
done
if is_projection_current "$pid" "$sid" "context"; then
  fail "Stale projection should return 1"
else
  pass "Stale projection returns 1"
fi

# Test 3: Missing projection file
echo "Test 3: Missing projection"
if is_projection_current "$pid" "nonexistent" "context"; then
  fail "Missing projection should return 1"
else
  pass "Missing projection returns 1"
fi

# Test 4: No events directory
echo "Test 4: No events directory"
mkdir -p "$CLAUDE_CONTEXT_PATH/projections/$pid/no-events"
printf '{"_projection":"context","_last_sequence":10,"data":{}}' > "$CLAUDE_CONTEXT_PATH/projections/$pid/no-events/context.json"
if is_projection_current "$pid" "no-events" "context"; then
  fail "No events dir should return 1"
else
  pass "No events dir returns 1"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
