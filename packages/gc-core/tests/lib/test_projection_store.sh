#!/usr/bin/env bash
# Tests for projection_store.sh (Task 03/11)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Use a temp directory as the context store so we don't touch real data
TEST_DIR="$(mktemp -d)"
export CLAUDE_CONTEXT_PATH="$TEST_DIR/store"

# Source the module under test
source "$PROJECT_ROOT/src/lib/projection_store.sh"

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

cleanup() {
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Test 1: gc_ensure_projection_dir creates directory and returns path
# ---------------------------------------------------------------------------
echo "=== Test 1: gc_ensure_projection_dir creates directory ==="
result="$(gc_ensure_projection_dir "proj-abc123" "s1")"
expected="$GC_PROJECTIONS_DIR/proj-abc123/s1"
if [[ -d "$result" ]]; then
  pass "directory was created"
else
  fail "directory does not exist: $result"
fi
if [[ "$result" == "$expected" ]]; then
  pass "returned correct path"
else
  fail "path mismatch: got '$result', expected '$expected'"
fi

# ---------------------------------------------------------------------------
# Test 2: gc_write_projection creates file with metadata envelope
# ---------------------------------------------------------------------------
echo "=== Test 2: gc_write_projection creates timeline.json with metadata ==="
gc_write_projection "proj-abc123" "s1" "timeline" '[]' 10 10

proj_file="$GC_PROJECTIONS_DIR/proj-abc123/s1/timeline.json"
if [[ -f "$proj_file" ]]; then
  pass "timeline.json was created"
else
  fail "timeline.json does not exist at $proj_file"
fi

# ---------------------------------------------------------------------------
# Test 3: Verify metadata fields
# ---------------------------------------------------------------------------
echo "=== Test 3: Verify metadata fields ==="
content="$(cat "$proj_file")"

check_field() {
  local field="$1"
  local expected="$2"
  local actual
  actual="$(echo "$content" | jq -r ".$field")"
  if [[ "$actual" == "$expected" ]]; then
    pass "field $field == $expected"
  else
    fail "field $field: got '$actual', expected '$expected'"
  fi
}

check_field "_projection" "timeline"
check_field "_project_id" "proj-abc123"
check_field "_session_id" "s1"
check_field "_event_count" "10"
check_field "_last_sequence" "10"

# Verify _rebuilt_at is a valid ISO 8601 date
rebuilt_at="$(echo "$content" | jq -r '._rebuilt_at')"
if [[ "$rebuilt_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
  pass "_rebuilt_at is valid ISO 8601 format"
else
  fail "_rebuilt_at is not valid ISO 8601: '$rebuilt_at'"
fi

# Verify data field
data="$(echo "$content" | jq -c '.data')"
if [[ "$data" == "[]" ]]; then
  pass "data field matches input"
else
  fail "data field mismatch: got '$data', expected '[]'"
fi

# ---------------------------------------------------------------------------
# Test 4: gc_is_projection_stale returns 1 (current) when event count matches
# ---------------------------------------------------------------------------
echo "=== Test 4: gc_is_projection_stale returns 1 (current) when event count matches ==="
# Create event files to match _last_sequence of 10
events_dir="$(gc_session_events_dir "proj-abc123" "s1")"
mkdir -p "$events_dir"
for i in $(seq 1 10); do
  echo '{"type":"test"}' > "${events_dir}/${i}.json"
done

if gc_is_projection_stale "proj-abc123" "s1" "timeline"; then
  fail "should have returned 1 (current), but returned 0 (stale)"
else
  pass "returned 1 (current) when event count matches _last_sequence"
fi

# ---------------------------------------------------------------------------
# Test 5: gc_is_projection_stale returns 0 (stale) after adding an event
# ---------------------------------------------------------------------------
echo "=== Test 5: gc_is_projection_stale returns 0 (stale) after adding event ==="
echo '{"type":"new_event"}' > "${events_dir}/11.json"

if gc_is_projection_stale "proj-abc123" "s1" "timeline"; then
  pass "returned 0 (stale) after adding event file"
else
  fail "should have returned 0 (stale), but returned 1 (current)"
fi

# ---------------------------------------------------------------------------
# Test 6: Projection writes are atomic (concurrent read during write)
# ---------------------------------------------------------------------------
echo "=== Test 6: Atomic projection writes ==="
# Write a large projection to increase the write window
large_data="$(jq -n '[range(1000) | {idx: ., value: "padding-data-to-make-the-payload-larger"}]')"
gc_write_projection "proj-abc123" "s1" "atomic-test" "$large_data" 5 5

# Start a background write while simultaneously reading
(
  source "$PROJECT_ROOT/src/lib/projection_store.sh"
  new_data="$(jq -n '[range(1000) | {idx: ., value: "updated-padding-data-for-the-payload"}]')"
  gc_write_projection "proj-abc123" "s1" "atomic-test" "$new_data" 10 10
) &
write_pid=$!

# Read immediately (several times to catch mid-write states)
read_ok=true
for _ in $(seq 1 5); do
  read_content="$(gc_read_projection "proj-abc123" "s1" "atomic-test")"
  if [[ -n "$read_content" ]]; then
    # Validate that the content is valid JSON (not partial/corrupt)
    if ! echo "$read_content" | jq . >/dev/null 2>&1; then
      read_ok=false
      break
    fi
  fi
done

wait "$write_pid" || true

if $read_ok; then
  pass "concurrent reads during write always returned valid JSON"
else
  fail "concurrent read returned corrupt/partial content"
fi

# ---------------------------------------------------------------------------
# Test 7: gc_is_projection_stale returns 0 (stale) when projection file missing
# ---------------------------------------------------------------------------
echo "=== Test 7: gc_is_projection_stale returns 0 (stale) when file is deleted ==="
# Remove all projection files for this session
rm -f "$GC_PROJECTIONS_DIR/proj-abc123/s1/timeline.json"

if gc_is_projection_stale "proj-abc123" "s1" "timeline"; then
  pass "returned 0 (stale) when projection file is missing"
else
  fail "should have returned 0 (stale) for missing file, got 1 (current)"
fi

# ---------------------------------------------------------------------------
# Test 8: gc_is_projection_stale excludes session.json and non-numeric files
# ---------------------------------------------------------------------------
echo "=== Test 8: Staleness check uses [0-9]*.json pattern (excludes session.json) ==="
# Create a fresh setup
fresh_events="$(gc_session_events_dir "proj-fresh" "s2")"
mkdir -p "$fresh_events"
# Write 3 event files
for i in 1 2 3; do
  echo '{"type":"test"}' > "${fresh_events}/${i}.json"
done
# Write non-event files that should be excluded
echo '{"session":"data"}' > "${fresh_events}/session.json"
echo '{"rejected":"data"}' > "${fresh_events}/rejected_001.json"
echo "lock" > "${fresh_events}/.lock"

# Write a projection with _last_sequence=3
gc_write_projection "proj-fresh" "s2" "timeline" '[]' 3 3

if gc_is_projection_stale "proj-fresh" "s2" "timeline"; then
  fail "should have returned 1 (current) -- non-event files were counted"
else
  pass "correctly excluded session.json, rejected_*, and .lock from event count"
fi

# ---------------------------------------------------------------------------
# Test 9: gc_read_projection returns empty string for non-existent file
# ---------------------------------------------------------------------------
echo "=== Test 9: gc_read_projection returns empty for non-existent file ==="
result="$(gc_read_projection "proj-nonexistent" "s-none" "timeline")"
if [[ -z "$result" ]]; then
  pass "returned empty string for missing projection"
else
  fail "expected empty string, got: '$result'"
fi

# ---------------------------------------------------------------------------
# Test 10: gc_read_projection returns content for existing file
# ---------------------------------------------------------------------------
echo "=== Test 10: gc_read_projection returns content for existing file ==="
gc_write_projection "proj-read" "s3" "decisions" '{"items":[]}' 5 5
result="$(gc_read_projection "proj-read" "s3" "decisions")"
if [[ -n "$result" ]]; then
  proj_name="$(echo "$result" | jq -r '._projection')"
  if [[ "$proj_name" == "decisions" ]]; then
    pass "read_projection returned correct content"
  else
    fail "unexpected _projection value: '$proj_name'"
  fi
else
  fail "read_projection returned empty for existing file"
fi

# ---------------------------------------------------------------------------
# Test 11: gc_ensure_projection_dir is idempotent
# ---------------------------------------------------------------------------
echo "=== Test 11: gc_ensure_projection_dir is idempotent ==="
dir1="$(gc_ensure_projection_dir "proj-idem" "s4")"
dir2="$(gc_ensure_projection_dir "proj-idem" "s4")"
if [[ "$dir1" == "$dir2" ]] && [[ -d "$dir1" ]]; then
  pass "idempotent: same path returned, directory exists"
else
  fail "idempotent check failed: '$dir1' vs '$dir2'"
fi

# ---------------------------------------------------------------------------
# Test 12: gc_write_projection with complex data_json
# ---------------------------------------------------------------------------
echo "=== Test 12: gc_write_projection with complex nested JSON ==="
complex_data='{"files":["/a/b.ts","/c/d.py"],"counts":{"read":3,"write":1}}'
gc_write_projection "proj-complex" "s5" "files-touched" "$complex_data" 7 7
result="$(gc_read_projection "proj-complex" "s5" "files-touched")"
data_field="$(echo "$result" | jq -c '.data')"
expected_data="$(echo "$complex_data" | jq -c '.')"
if [[ "$data_field" == "$expected_data" ]]; then
  pass "complex nested JSON preserved in data field"
else
  fail "data mismatch: got '$data_field', expected '$expected_data'"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "================================="
echo "Results: $PASS passed, $FAIL failed"
echo "================================="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
