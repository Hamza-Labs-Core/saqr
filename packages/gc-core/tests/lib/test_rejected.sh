#!/usr/bin/env bash
# Tests for gc_write_rejected_event (Task 03/14)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Use a temp directory as the context store so we don't touch real data
TEST_DIR="$(mktemp -d)"
export CLAUDE_CONTEXT_PATH="$TEST_DIR/store"

# Source the module under test
source "$PROJECT_ROOT/src/lib/rejected.sh"

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

# Pre-create the events directory structure (normally done by gc-init / session_dir)
PROJECT_ID="myproject-abc123"
SESSION_ID="session-001"
SESSION_DIR="$CLAUDE_CONTEXT_PATH/events/$PROJECT_ID/$SESSION_ID"
mkdir -p "$SESSION_DIR"

echo "=== Test 1: Write a rejected event -- file appears in _rejected/ with correct structure ==="
result="$(gc_write_rejected_event "$PROJECT_ID" "$SESSION_ID" '{"bad":"data"}' "invalid schema: missing type field")"
if [[ -f "$result" ]]; then
  pass "rejected event file was created"
else
  fail "rejected event file does not exist at: $result"
fi

# Verify it is in the _rejected directory
if [[ "$result" == *"/_rejected/"* ]]; then
  pass "file is inside _rejected/ directory"
else
  fail "file is not inside _rejected/ directory: $result"
fi

# Verify filename pattern: {timestamp}-{uuid}.json
basename_file="$(basename "$result")"
if [[ "$basename_file" =~ ^[0-9]{8}T[0-9]{9}Z-[a-f0-9-]+\.json$ ]]; then
  pass "filename matches {timestamp}-{uuid}.json pattern"
else
  fail "filename does not match expected pattern: $basename_file"
fi

# Verify JSON structure
if command -v jq &>/dev/null; then
  # Check _rejected_at field exists and is ISO 8601-ish
  rejected_at="$(jq -r '._rejected_at' "$result")"
  if [[ "$rejected_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]]; then
    pass "_rejected_at field contains ISO 8601 timestamp"
  else
    fail "_rejected_at field is not ISO 8601: $rejected_at"
  fi

  # Check _reason field
  reason="$(jq -r '._reason' "$result")"
  if [[ "$reason" == "invalid schema: missing type field" ]]; then
    pass "_reason field matches the error_reason"
  else
    fail "_reason field mismatch: got '$reason'"
  fi

  # Check _original_content field
  original="$(jq -r '._original_content' "$result")"
  if [[ "$original" == '{"bad":"data"}' ]]; then
    pass "_original_content field preserves the original content"
  else
    fail "_original_content field mismatch: got '$original'"
  fi
else
  echo "  SKIP: jq not available for JSON structure validation"
fi

echo ""
echo "=== Test 2: Rejected files do not interfere with sequence numbering ==="
# Create a fake event file to simulate existing events
touch "$SESSION_DIR/000001-fake-event.json"
# Write another rejected event
result2="$(gc_write_rejected_event "$PROJECT_ID" "$SESSION_ID" 'bad content' "parse error")"
# Verify the rejected file is in _rejected/, not in the session dir root
rejected_dir="$SESSION_DIR/_rejected"
if [[ -d "$rejected_dir" ]]; then
  # Count files in _rejected/
  rejected_count="$(find "$rejected_dir" -maxdepth 1 -name '*.json' | wc -l)"
  # Count event files in session dir root (exclude _rejected dir and .lock)
  event_count="$(find "$SESSION_DIR" -maxdepth 1 -name '*.json' | wc -l)"
  if [[ "$event_count" -eq 1 ]] && [[ "$rejected_count" -ge 2 ]]; then
    pass "rejected files are separate from event files (events: $event_count, rejected: $rejected_count)"
  else
    fail "file count unexpected (events: $event_count, rejected: $rejected_count)"
  fi
else
  fail "_rejected directory does not exist"
fi

echo ""
echo "=== Test 3: Multiple rejected events create separate files (no overwrites) ==="
result3a="$(gc_write_rejected_event "$PROJECT_ID" "$SESSION_ID" 'content A' "reason A")"
# Small sleep to ensure different timestamp
sleep 0.01
result3b="$(gc_write_rejected_event "$PROJECT_ID" "$SESSION_ID" 'content B' "reason B")"

if [[ "$result3a" != "$result3b" ]]; then
  pass "multiple rejected events have different file paths"
else
  fail "two rejected events produced the same file path"
fi

if [[ -f "$result3a" ]] && [[ -f "$result3b" ]]; then
  pass "both rejected event files exist (no overwrite)"
else
  fail "one or both rejected event files are missing"
fi

# Verify they have different content
if command -v jq &>/dev/null; then
  reason_a="$(jq -r '._reason' "$result3a")"
  reason_b="$(jq -r '._reason' "$result3b")"
  if [[ "$reason_a" == "reason A" ]] && [[ "$reason_b" == "reason B" ]]; then
    pass "each rejected file has its own distinct reason"
  else
    fail "reason mismatch: got '$reason_a' and '$reason_b'"
  fi
fi

echo ""
echo "=== Test 4: The _reason field explains why the event was rejected ==="
result4="$(gc_write_rejected_event "$PROJECT_ID" "$SESSION_ID" '{}' "JSON validation failed: required field 'type' is missing")"
if command -v jq &>/dev/null; then
  reason4="$(jq -r '._reason' "$result4")"
  if [[ "$reason4" == "JSON validation failed: required field 'type' is missing" ]]; then
    pass "_reason field contains detailed error explanation"
  else
    fail "_reason field mismatch: got '$reason4'"
  fi
else
  # Fallback: just check the file contains the reason string
  if grep -q "required field" "$result4"; then
    pass "_reason field contains error explanation (grep check)"
  else
    fail "_reason field does not contain expected error text"
  fi
fi

echo ""
echo "=== Test 5: Content truncation for very large content ==="
# Generate content larger than 10KB
large_content="$(printf '%0.sX' $(seq 1 15000))"
result5="$(gc_write_rejected_event "$PROJECT_ID" "$SESSION_ID" "$large_content" "too large")"
if [[ -f "$result5" ]]; then
  file_size="$(wc -c < "$result5")"
  # The file should be significantly smaller than the raw input
  if [[ "$file_size" -lt 15000 ]]; then
    pass "large content was truncated (file size: $file_size bytes)"
  else
    fail "large content was not truncated (file size: $file_size bytes)"
  fi
  if command -v jq &>/dev/null; then
    original5="$(jq -r '._original_content' "$result5")"
    if [[ "$original5" == *"truncated"* ]]; then
      pass "truncated content includes truncation notice"
    else
      fail "truncated content does not include truncation notice"
    fi
  fi
else
  fail "rejected event file for large content not created"
fi

echo ""
echo "=== Test 6: Empty content is handled ==="
result6="$(gc_write_rejected_event "$PROJECT_ID" "$SESSION_ID" "" "empty payload")"
if [[ -f "$result6" ]]; then
  if command -v jq &>/dev/null; then
    original6="$(jq -r '._original_content' "$result6")"
    if [[ "$original6" == "" ]]; then
      pass "empty content is preserved as empty string"
    else
      fail "empty content was not preserved: got '$original6'"
    fi
    reason6="$(jq -r '._reason' "$result6")"
    if [[ "$reason6" == "empty payload" ]]; then
      pass "reason is correct for empty content case"
    else
      fail "reason mismatch for empty content: got '$reason6'"
    fi
  else
    pass "rejected event file created for empty content"
  fi
else
  fail "rejected event file for empty content not created"
fi

echo ""
echo "=== Test 7: _rejected directory is auto-created ==="
NEW_SESSION="fresh-session"
NEW_SESSION_DIR="$CLAUDE_CONTEXT_PATH/events/$PROJECT_ID/$NEW_SESSION"
mkdir -p "$NEW_SESSION_DIR"
# No _rejected dir exists yet
result7="$(gc_write_rejected_event "$PROJECT_ID" "$NEW_SESSION" 'fail' "auto-create test")"
if [[ -d "$NEW_SESSION_DIR/_rejected" ]]; then
  pass "_rejected directory was auto-created"
else
  fail "_rejected directory was not auto-created"
fi
if [[ -f "$result7" ]]; then
  pass "rejected event file was written in auto-created directory"
else
  fail "rejected event file was not written"
fi

echo ""
echo "=== Test 8: Special characters in content and reason ==="
special_content=$'line1\nline2\t"quoted"\n\\backslash'
special_reason='reason with "quotes" and \backslash'
result8="$(gc_write_rejected_event "$PROJECT_ID" "$SESSION_ID" "$special_content" "$special_reason")"
if [[ -f "$result8" ]]; then
  if command -v jq &>/dev/null; then
    # If jq can parse it, the JSON is valid
    if jq '.' "$result8" >/dev/null 2>&1; then
      pass "special characters produce valid JSON"
    else
      fail "special characters produced invalid JSON"
    fi
    reason8="$(jq -r '._reason' "$result8")"
    if [[ "$reason8" == "$special_reason" ]]; then
      pass "special characters in reason are preserved"
    else
      fail "special characters in reason were mangled: got '$reason8'"
    fi
  else
    pass "rejected event file created with special characters"
  fi
else
  fail "rejected event file not created for special characters test"
fi

echo ""
echo "================================="
echo "Results: $PASS passed, $FAIL failed"
echo "================================="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
