#!/usr/bin/env bash
set -euo pipefail

# Test Task 02: Directory Structure and install.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_SH="$PROJECT_ROOT/src/install.sh"

RESULT_FILE=$(mktemp)
echo "0 0" > "$RESULT_FILE"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"; rm -f "$RESULT_FILE"' EXIT

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

echo "=== Task 02: install.sh Tests ==="

# Test 1: Clean install creates all directories
echo ""
echo "--- Test 1: Clean install ---"
export CLAUDE_CONTEXT_PATH="$TEST_DIR/store1"
bash "$INSTALL_SH" >/dev/null 2>&1

if [ -d "$TEST_DIR/store1" ]; then echo "  PASS: root dir exists"; _record_pass; else echo "  FAIL: root dir missing"; _record_fail; fi
if [ -d "$TEST_DIR/store1/events" ]; then echo "  PASS: events/ exists"; _record_pass; else echo "  FAIL: events/ missing"; _record_fail; fi
if [ -d "$TEST_DIR/store1/projections" ]; then echo "  PASS: projections/ exists"; _record_pass; else echo "  FAIL: projections/ missing"; _record_fail; fi
if [ -d "$TEST_DIR/store1/bin" ]; then echo "  PASS: bin/ exists"; _record_pass; else echo "  FAIL: bin/ missing"; _record_fail; fi

# Test 2: config.json exists and has required fields
echo ""
echo "--- Test 2: config.json ---"
if [ -f "$TEST_DIR/store1/config.json" ]; then
  echo "  PASS: config.json exists"; _record_pass
  has_version=$(jq -r '.version' "$TEST_DIR/store1/config.json" 2>/dev/null)
  has_events_dir=$(jq -r '.events_dir' "$TEST_DIR/store1/config.json" 2>/dev/null)
  has_created=$(jq -r '.created_at' "$TEST_DIR/store1/config.json" 2>/dev/null)
  assert_eq "config.json has version" "1.0.0" "$has_version"
  assert_eq "config.json has events_dir" "events" "$has_events_dir"
  if [ -n "$has_created" ] && [ "$has_created" != "null" ]; then
    echo "  PASS: config.json has created_at"; _record_pass
  else
    echo "  FAIL: config.json missing created_at"; _record_fail
  fi
else
  echo "  FAIL: config.json missing"; _record_fail
fi

# Test 3: capture-event installed in bin/ with execute permission
echo ""
echo "--- Test 3: capture-event in bin/ ---"
if [ -f "$TEST_DIR/store1/bin/capture-event" ]; then
  echo "  PASS: capture-event installed"; _record_pass
  if [ -x "$TEST_DIR/store1/bin/capture-event" ]; then
    echo "  PASS: capture-event is executable"; _record_pass
  else
    echo "  FAIL: capture-event not executable"; _record_fail
  fi
else
  echo "  FAIL: capture-event not installed"; _record_fail
fi

# Test 4: Idempotency -- run install a second time
echo ""
echo "--- Test 4: Idempotent second run ---"
# Save config.json content before second run
config_before=$(cat "$TEST_DIR/store1/config.json")
bash "$INSTALL_SH" >/dev/null 2>&1
config_after=$(cat "$TEST_DIR/store1/config.json")
assert_eq "config.json preserved after second run" "$config_before" "$config_after"

# Test 5: jq missing aborts install
echo ""
echo "--- Test 5: jq missing aborts ---"
export CLAUDE_CONTEXT_PATH="$TEST_DIR/store-nojq"
result=0
PATH="/usr/bin/does-not-exist" bash "$INSTALL_SH" 2>/dev/null || result=$?
if [ "$result" -ne 0 ]; then
  echo "  PASS: install.sh aborts when jq missing"; _record_pass
else
  echo "  FAIL: install.sh should abort when jq missing"; _record_fail
fi

# Test 6: CLAUDE_CONTEXT_PATH respected
echo ""
echo "--- Test 6: Custom path ---"
export CLAUDE_CONTEXT_PATH="$TEST_DIR/custom-store"
bash "$INSTALL_SH" >/dev/null 2>&1
if [ -d "$TEST_DIR/custom-store/events" ]; then
  echo "  PASS: custom CLAUDE_CONTEXT_PATH respected"; _record_pass
else
  echo "  FAIL: custom CLAUDE_CONTEXT_PATH not respected"; _record_fail
fi

# Test 7: Root directory permissions are 700
echo ""
echo "--- Test 7: Root dir permissions ---"
perms=$(stat -c '%a' "$TEST_DIR/store1" 2>/dev/null || stat -f '%A' "$TEST_DIR/store1" 2>/dev/null)
assert_eq "root dir permissions are 700" "700" "$perms"

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
