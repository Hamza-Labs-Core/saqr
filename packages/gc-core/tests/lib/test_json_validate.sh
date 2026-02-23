#!/usr/bin/env bash
# Tests for src/lib/json_validate.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source the module under test
source "$PROJECT_ROOT/src/lib/json_validate.sh"

PASS=0
FAIL=0

pass() {
  PASS=$((PASS + 1))
  echo "  PASS: $1"
}

fail() {
  FAIL=$((FAIL + 1))
  echo "  FAIL: $1"
}

# ---------------------------------------------------------------------------
# Test 1: Valid event JSON -- returns 0
# ---------------------------------------------------------------------------
echo "Test 1: Valid event JSON returns 0"
VALID_EVENT='{
  "event_id": "abc-123",
  "event_type": "context.created",
  "project_id": "myproj-a1b2c3",
  "session_id": "sess-001",
  "sequence": 1,
  "timestamp": "2026-02-15T00:00:00Z",
  "data": {"key": "value"}
}'
if gc_validate_event_json "$VALID_EVENT" 2>/dev/null; then
  pass "valid event JSON accepted"
else
  fail "valid event JSON rejected"
fi

# ---------------------------------------------------------------------------
# Test 2: Malformed JSON (missing closing brace) -- returns 1
# ---------------------------------------------------------------------------
echo "Test 2: Malformed JSON returns 1"
MALFORMED='{"event_id": "abc-123", "event_type": "context.created"'
if gc_validate_event_json "$MALFORMED" 2>/dev/null; then
  fail "malformed JSON accepted (should have been rejected)"
else
  pass "malformed JSON rejected"
fi

# ---------------------------------------------------------------------------
# Test 3: JSON missing event_id -- returns 1
# ---------------------------------------------------------------------------
echo "Test 3: Missing event_id returns 1"
MISSING_FIELD='{
  "event_type": "context.created",
  "project_id": "myproj-a1b2c3",
  "session_id": "sess-001",
  "sequence": 1,
  "timestamp": "2026-02-15T00:00:00Z",
  "data": {"key": "value"}
}'
if gc_validate_event_json "$MISSING_FIELD" 2>/dev/null; then
  fail "JSON missing event_id accepted (should have been rejected)"
else
  pass "JSON missing event_id rejected"
fi

# ---------------------------------------------------------------------------
# Test 4: JSON with sequence: "not_a_number" -- returns 1
# ---------------------------------------------------------------------------
echo "Test 4: Non-numeric sequence returns 1"
BAD_SEQUENCE='{
  "event_id": "abc-123",
  "event_type": "context.created",
  "project_id": "myproj-a1b2c3",
  "session_id": "sess-001",
  "sequence": "not_a_number",
  "timestamp": "2026-02-15T00:00:00Z",
  "data": {"key": "value"}
}'
if gc_validate_event_json "$BAD_SEQUENCE" 2>/dev/null; then
  fail "non-numeric sequence accepted (should have been rejected)"
else
  pass "non-numeric sequence rejected"
fi

# ---------------------------------------------------------------------------
# Test 5: JSON with data: null -- returns 1
# ---------------------------------------------------------------------------
echo "Test 5: data: null returns 1"
NULL_DATA='{
  "event_id": "abc-123",
  "event_type": "context.created",
  "project_id": "myproj-a1b2c3",
  "session_id": "sess-001",
  "sequence": 1,
  "timestamp": "2026-02-15T00:00:00Z",
  "data": null
}'
if gc_validate_event_json "$NULL_DATA" 2>/dev/null; then
  fail "data: null accepted (should have been rejected)"
else
  pass "data: null rejected"
fi

# ---------------------------------------------------------------------------
# Test 6: Valid non-event JSON via gc_validate_json -- returns 0
# ---------------------------------------------------------------------------
echo "Test 6: Valid non-event JSON via gc_validate_json returns 0"
SIMPLE_JSON='{"name": "test", "version": 1}'
if gc_validate_json "$SIMPLE_JSON" 2>/dev/null; then
  pass "valid non-event JSON accepted by gc_validate_json"
else
  fail "valid non-event JSON rejected by gc_validate_json"
fi

# ---------------------------------------------------------------------------
# Additional edge-case tests
# ---------------------------------------------------------------------------

echo "Test 7: gc_validate_json rejects malformed JSON"
if gc_validate_json '{"broken":' 2>/dev/null; then
  fail "malformed JSON accepted by gc_validate_json"
else
  pass "malformed JSON rejected by gc_validate_json"
fi

echo "Test 8: gc_validate_json rejects empty input"
if gc_validate_json "" 2>/dev/null; then
  fail "empty input accepted by gc_validate_json"
else
  pass "empty input rejected by gc_validate_json"
fi

echo "Test 9: gc_validate_event_json accepts data as string (malformed JSON fallback)"
STRING_DATA='{
  "event_id": "abc-123",
  "event_type": "context.created",
  "project_id": "myproj-a1b2c3",
  "session_id": "sess-001",
  "sequence": 1,
  "timestamp": "2026-02-15T00:00:00Z",
  "data": "not_an_object"
}'
if gc_validate_event_json "$STRING_DATA" 2>/dev/null; then
  pass "data as string accepted (malformed JSON fallback)"
else
  fail "data as string rejected (should be accepted for malformed JSON)"
fi

echo "Test 10: gc_validate_event_json rejects empty timestamp"
EMPTY_TS='{
  "event_id": "abc-123",
  "event_type": "context.created",
  "project_id": "myproj-a1b2c3",
  "session_id": "sess-001",
  "sequence": 1,
  "timestamp": "",
  "data": {"key": "value"}
}'
if gc_validate_event_json "$EMPTY_TS" 2>/dev/null; then
  fail "empty timestamp accepted (should have been rejected)"
else
  pass "empty timestamp rejected"
fi

echo "Test 11: gc_validate_event_json rejects sequence 0"
ZERO_SEQ='{
  "event_id": "abc-123",
  "event_type": "context.created",
  "project_id": "myproj-a1b2c3",
  "session_id": "sess-001",
  "sequence": 0,
  "timestamp": "2026-02-15T00:00:00Z",
  "data": {"key": "value"}
}'
if gc_validate_event_json "$ZERO_SEQ" 2>/dev/null; then
  fail "sequence 0 accepted (should have been rejected)"
else
  pass "sequence 0 rejected"
fi

echo "Test 12: gc_validate_event_json rejects negative sequence"
NEG_SEQ='{
  "event_id": "abc-123",
  "event_type": "context.created",
  "project_id": "myproj-a1b2c3",
  "session_id": "sess-001",
  "sequence": -5,
  "timestamp": "2026-02-15T00:00:00Z",
  "data": {"key": "value"}
}'
if gc_validate_event_json "$NEG_SEQ" 2>/dev/null; then
  fail "negative sequence accepted (should have been rejected)"
else
  pass "negative sequence rejected"
fi

echo "Test 13: gc_validate_event_json rejects data as array"
ARRAY_DATA='{
  "event_id": "abc-123",
  "event_type": "context.created",
  "project_id": "myproj-a1b2c3",
  "session_id": "sess-001",
  "sequence": 1,
  "timestamp": "2026-02-15T00:00:00Z",
  "data": [1, 2, 3]
}'
if gc_validate_event_json "$ARRAY_DATA" 2>/dev/null; then
  fail "data as array accepted (should have been rejected)"
else
  pass "data as array rejected"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed out of $((PASS + FAIL)) tests"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

echo "All tests passed."
exit 0
