#!/usr/bin/env bash
# Tests for session_resolve.sh (Task 05)
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

source "$PROJECT_ROOT/src/lib/session_resolve.sh"

pid="proj-test123"

# Create test sessions
mkdir -p "$CLAUDE_CONTEXT_PATH/events/$pid/abc-123-def"
mkdir -p "$CLAUDE_CONTEXT_PATH/events/$pid/abc-456-ghi"
mkdir -p "$CLAUDE_CONTEXT_PATH/events/$pid/xyz-789"
# Add event files so validate works
printf '{"event_type":"Test"}' > "$CLAUDE_CONTEXT_PATH/events/$pid/abc-123-def/000001.json"
printf '{"event_type":"Test"}' > "$CLAUDE_CONTEXT_PATH/events/$pid/abc-456-ghi/000001.json"
printf '{"event_type":"Test"}' > "$CLAUDE_CONTEXT_PATH/events/$pid/xyz-789/000001.json"

echo "=== Testing session_resolve.sh ==="

# Test 1: Latest session via symlink
echo "Test 1: resolve_latest_session with symlink"
mkdir -p "$CLAUDE_CONTEXT_PATH/projections/$pid"
ln -sfn "abc-123-def" "$CLAUDE_CONTEXT_PATH/projections/$pid/latest"
result="$(resolve_latest_session "$pid")"
if [[ "$result" == "abc-123-def" ]]; then pass "Latest via symlink"; else fail "Latest via symlink: got $result"; fi

# Test 2: Latest session fallback (no symlink)
echo "Test 2: resolve_latest_session fallback"
rm -f "$CLAUDE_CONTEXT_PATH/projections/$pid/latest"
# Set older mtime on abc dirs, newer on xyz
touch -t 202001010000 "$CLAUDE_CONTEXT_PATH/events/$pid/abc-123-def"
touch -t 202001010000 "$CLAUDE_CONTEXT_PATH/events/$pid/abc-456-ghi"
touch -t 203001010000 "$CLAUDE_CONTEXT_PATH/events/$pid/xyz-789"
result2="$(resolve_latest_session "$pid")"
if [[ "$result2" == "xyz-789" ]]; then pass "Latest fallback to mtime"; else fail "Latest fallback: got $result2"; fi

# Test 3: Exact match resolution
echo "Test 3: resolve_session_id exact match"
result3="$(resolve_session_id "$pid" "abc-123-def")"
if [[ "$result3" == "abc-123-def" ]]; then pass "Exact match"; else fail "Exact match: got $result3"; fi

# Test 4: Unique prefix match
echo "Test 4: resolve_session_id unique prefix"
result4="$(resolve_session_id "$pid" "xyz")"
if [[ "$result4" == "xyz-789" ]]; then pass "Unique prefix match"; else fail "Unique prefix: got $result4"; fi

# Test 5: Ambiguous prefix (exit code 2)
echo "Test 5: resolve_session_id ambiguous prefix"
if resolve_session_id "$pid" "abc" 2>/dev/null; then
  fail "Ambiguous prefix should fail"
else
  rc=$?
  if [[ $rc -eq 2 ]]; then pass "Ambiguous prefix exits 2"; else fail "Ambiguous prefix: exit code $rc"; fi
fi

# Test 6: No match (exit code 3)
echo "Test 6: resolve_session_id no match"
if resolve_session_id "$pid" "nonexistent" 2>/dev/null; then
  fail "No match should fail"
else
  rc=$?
  if [[ $rc -eq 3 ]]; then pass "No match exits 3"; else fail "No match: exit code $rc"; fi
fi

# Test 7: validate_session_exists with events
echo "Test 7: validate_session_exists valid"
if validate_session_exists "$pid" "abc-123-def"; then
  pass "Valid session with events"
else
  fail "Should validate session with events"
fi

# Test 8: validate_session_exists without events
echo "Test 8: validate_session_exists no events"
mkdir -p "$CLAUDE_CONTEXT_PATH/events/$pid/empty-session"
if validate_session_exists "$pid" "empty-session"; then
  fail "Empty session should fail validation"
else
  pass "Empty session fails validation"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
