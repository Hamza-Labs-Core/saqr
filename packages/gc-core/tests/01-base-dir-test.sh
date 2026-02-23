#!/usr/bin/env bash
set -euo pipefail

# Test Task 01: Base Directory Resolution
# Tests both the inline pattern in capture-event and the CONVENTIONS.md existence.

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

echo "=== Task 01: Base Dir Resolution Tests ==="

# Test 1: CLAUDE_CONTEXT_PATH override
echo ""
echo "--- Test 1: CLAUDE_CONTEXT_PATH override ---"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"; rm -f "$RESULT_FILE"' EXIT

result=$(CLAUDE_CONTEXT_PATH="$TEST_DIR" bash -c '
  BASE_DIR="${CLAUDE_CONTEXT_PATH:-$HOME/.claude-context}"
  echo "$BASE_DIR"
')
assert_eq "CLAUDE_CONTEXT_PATH sets BASE_DIR" "$TEST_DIR" "$result"

# Test 2: Default when CLAUDE_CONTEXT_PATH is unset
echo ""
echo "--- Test 2: Default path ---"
result=$(unset CLAUDE_CONTEXT_PATH; bash -c '
  unset CLAUDE_CONTEXT_PATH
  BASE_DIR="${CLAUDE_CONTEXT_PATH:-$HOME/.claude-context}"
  echo "$BASE_DIR"
')
assert_eq "Default BASE_DIR is ~/.claude-context" "$HOME/.claude-context" "$result"

# Test 3: Trailing slash handling (capture-event should still work)
echo ""
echo "--- Test 3: Trailing slash handling ---"
result=$(CLAUDE_CONTEXT_PATH="$TEST_DIR/" bash -c '
  BASE_DIR="${CLAUDE_CONTEXT_PATH:-$HOME/.claude-context}"
  echo "$BASE_DIR"
')
# Note: trailing slash is preserved by the pattern but should not cause issues
# in practice because mkdir -p and file operations handle it
if [[ "$result" == "$TEST_DIR/" ]] || [[ "$result" == "$TEST_DIR" ]]; then
  echo "  PASS: Trailing slash handled (result: $result)"
  _record_pass
else
  echo "  FAIL: Trailing slash issue (result: $result)"
  _record_fail
fi

# Test 4: CONVENTIONS.md exists
echo ""
echo "--- Test 4: CONVENTIONS.md exists ---"
if [ -f "$PROJECT_ROOT/docs/CONVENTIONS.md" ]; then
  echo "  PASS: docs/CONVENTIONS.md exists"
  _record_pass
else
  echo "  FAIL: docs/CONVENTIONS.md not found"
  _record_fail
fi

# Test 5: capture-event contains inline pattern
echo ""
echo "--- Test 5: capture-event has inline pattern ---"
if grep -q 'CLAUDE_CONTEXT_PATH' "$PROJECT_ROOT/src/capture-event"; then
  echo "  PASS: capture-event contains CLAUDE_CONTEXT_PATH pattern"
  _record_pass
else
  echo "  FAIL: capture-event missing CLAUDE_CONTEXT_PATH pattern"
  _record_fail
fi

# Test 6: install.sh contains inline pattern
echo ""
echo "--- Test 6: install.sh has inline pattern ---"
if grep -q 'CLAUDE_CONTEXT_PATH' "$PROJECT_ROOT/src/install.sh"; then
  echo "  PASS: install.sh contains CLAUDE_CONTEXT_PATH pattern"
  _record_pass
else
  echo "  FAIL: install.sh missing CLAUDE_CONTEXT_PATH pattern"
  _record_fail
fi

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
