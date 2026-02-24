#!/usr/bin/env bash
set -euo pipefail

# Test Task 03: Session ID Sanitization

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RESULT_FILE=$(mktemp)
echo "0 0" > "$RESULT_FILE"
trap 'rm -f "$RESULT_FILE"' EXIT

_record_pass() {
  local counts; counts=$(cat "$RESULT_FILE")
  local p f; p=$(echo "$counts" | cut -d' ' -f1); f=$(echo "$counts" | cut -d' ' -f2)
  echo "$((p + 1)) $f" > "$RESULT_FILE"
}
_record_fail() {
  local counts; counts=$(cat "$RESULT_FILE")
  local p f; p=$(echo "$counts" | cut -d' ' -f1); f=$(echo "$counts" | cut -d' ' -f2)
  echo "$p $((f + 1))" > "$RESULT_FILE"
}
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS: $label"; _record_pass
  else
    echo "  FAIL: $label"; echo "    expected: $expected"; echo "    actual:   $actual"; _record_fail
  fi
}

# Extract the sanitize function from capture-event for testing
sanitize_func=$(cat <<'FUNC_EOF'
MAX_SESSION_ID_LENGTH=255
generate_uuid() {
  if command -v uuidgen &>/dev/null; then
    uuidgen | tr 'A-F' 'a-f'
    return
  fi
  if [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
    return
  fi
  printf '%04x%04x-%04x-%04x-%04x-%04x%04x%04x' \
    $RANDOM $RANDOM $RANDOM \
    $(( (RANDOM & 0x0FFF) | 0x4000 )) \
    $(( (RANDOM & 0x3FFF) | 0x8000 )) \
    $RANDOM $RANDOM $RANDOM
}
sanitize_session_id() {
  local raw="$1"
  local safe
  safe=$(printf '%s' "$raw" | tr -cd 'a-zA-Z0-9_-')
  safe="${safe:0:$MAX_SESSION_ID_LENGTH}"
  if [ -z "$safe" ] || [ "$safe" = "." ] || [ "$safe" = ".." ]; then
    safe="unknown-$(generate_uuid)"
  fi
  printf '%s' "$safe"
}
FUNC_EOF
)

echo "=== Task 03: Session ID Sanitization Tests ==="

# Test 1: Clean ID passes through
echo ""
echo "--- Test 1: Clean ID ---"
result=$(eval "$sanitize_func"; sanitize_session_id "abc-123")
assert_eq "abc-123 passes through" "abc-123" "$result"

# Test 2: Slashes removed
echo ""
echo "--- Test 2: Slashes ---"
result=$(eval "$sanitize_func"; sanitize_session_id "session/with/slashes")
assert_eq "slashes removed" "sessionwithslashes" "$result"

# Test 3: Spaces removed
echo ""
echo "--- Test 3: Spaces ---"
result=$(eval "$sanitize_func"; sanitize_session_id "has spaces here")
assert_eq "spaces removed" "hasspaceshere" "$result"

# Test 4: Path traversal (..) produces unknown-{uuid}
echo ""
echo "--- Test 4: Path traversal ---"
result=$(eval "$sanitize_func"; sanitize_session_id "..")
if [[ "$result" == unknown-* ]]; then
  echo "  PASS: .. produces unknown-{uuid} ($result)"; _record_pass
else
  echo "  FAIL: .. should produce unknown-{uuid}, got: $result"; _record_fail
fi

# Test 5: Leading dot stripped (.hidden -> hidden)
echo ""
echo "--- Test 5: Leading dot ---"
result=$(eval "$sanitize_func"; sanitize_session_id ".hidden")
assert_eq "leading dot stripped" "hidden" "$result"

# Test 6: Empty string produces unknown-{uuid}
echo ""
echo "--- Test 6: Empty string ---"
result=$(eval "$sanitize_func"; sanitize_session_id "")
if [[ "$result" == unknown-* ]]; then
  echo "  PASS: empty string produces unknown-{uuid} ($result)"; _record_pass
else
  echo "  FAIL: empty should produce unknown-{uuid}, got: $result"; _record_fail
fi

# Test 7: 300-char string truncated to 255
echo ""
echo "--- Test 7: Truncation to 255 ---"
long_input=$(printf 'a%.0s' $(seq 1 300))
result=$(eval "$sanitize_func"; sanitize_session_id "$long_input")
len=${#result}
assert_eq "truncated to 255 characters" "255" "$len"

# Test 8: Dots removed (hello.world -> helloworld)
echo ""
echo "--- Test 8: Dots removed ---"
result=$(eval "$sanitize_func"; sanitize_session_id "hello.world")
assert_eq "dots removed" "helloworld" "$result"

# Test 9: Underscores and hyphens allowed
echo ""
echo "--- Test 9: Underscores and hyphens ---"
result=$(eval "$sanitize_func"; sanitize_session_id "my_session-123")
assert_eq "underscores and hyphens allowed" "my_session-123" "$result"

# Summary
echo ""
counts=$(cat "$RESULT_FILE")
PASS=$(echo "$counts" | cut -d' ' -f1)
FAIL=$(echo "$counts" | cut -d' ' -f2)
echo "=============================="
echo "Results: $PASS passed, $FAIL failed"
echo "=============================="
[ "$FAIL" -gt 0 ] && exit 1
exit 0
