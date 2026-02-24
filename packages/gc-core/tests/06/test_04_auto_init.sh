#!/usr/bin/env bash
# Test: Task 04 - Auto-Init on First Use
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLUGIN_DIR="$PROJECT_DIR/plugin"

TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

PASS=0
FAIL=0

assert() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "[PASS] $desc"
    PASS=$((PASS + 1))
  else
    echo "[FAIL] $desc"
    FAIL=$((FAIL + 1))
  fi
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "[PASS] $desc"
    PASS=$((PASS + 1))
  else
    echo "[FAIL] $desc (expected: $expected, got: $actual)"
    FAIL=$((FAIL + 1))
  fi
}

# Test 1: gc-init script is executable
assert "gc-init is executable" test -x "$PLUGIN_DIR/scripts/gc-init"

# Test 2: gc-init creates directories on empty store
INIT_TEST="$TEST_DIR/init-test"
export CLAUDE_CONTEXT_PATH="$INIT_TEST"
"$PLUGIN_DIR/scripts/gc-init"
assert "gc-init creates events directory" test -d "$INIT_TEST/events"
assert "gc-init creates projections directory" test -d "$INIT_TEST/projections"
assert "gc-init creates logs directory" test -d "$INIT_TEST/logs"

# Test 3: config.json exists with required fields
assert "config.json exists" test -f "$INIT_TEST/config.json"
assert "config.json is valid JSON" jq . "$INIT_TEST/config.json"

VERSION=$(jq -r '.version' "$INIT_TEST/config.json")
assert_eq "config.json has version" "1.0.0" "$VERSION"

SOURCE=$(jq -r '.source' "$INIT_TEST/config.json")
assert_eq "config.json has source=plugin" "plugin" "$SOURCE"

EVENTS_DIR_FIELD=$(jq -r '.events_dir' "$INIT_TEST/config.json")
assert_eq "config.json has events_dir" "events" "$EVENTS_DIR_FIELD"

assert "config.json has created_at" jq -e '.created_at' "$INIT_TEST/config.json"

# Test 4: Store has permissions 700
PERMS=$(stat -c '%a' "$INIT_TEST" 2>/dev/null || stat -f '%Lp' "$INIT_TEST" 2>/dev/null)
assert_eq "store has permissions 700" "700" "$PERMS"

# Test 5: Idempotent -- running again doesn't error
"$PLUGIN_DIR/scripts/gc-init"
assert "gc-init is idempotent (second run)" test -d "$INIT_TEST/events"

# Test 6: config.json is not overwritten on second run
CREATED_AT_1=$(jq -r '.created_at' "$INIT_TEST/config.json")
sleep 1
"$PLUGIN_DIR/scripts/gc-init"
CREATED_AT_2=$(jq -r '.created_at' "$INIT_TEST/config.json")
assert_eq "config.json not overwritten (created_at unchanged)" "$CREATED_AT_1" "$CREATED_AT_2"

# Test 7: Auto-init via gc-hook on empty store
AUTOINIT_TEST="$TEST_DIR/autoinit-test"
export CLAUDE_CONTEXT_PATH="$AUTOINIT_TEST"
echo '{"session_id":"init-via-hook"}' | "$PLUGIN_DIR/scripts/gc-hook" SessionStarted 2>/dev/null
assert "auto-init creates events via gc-hook" test -d "$AUTOINIT_TEST/events"
assert "auto-init creates projections via gc-hook" test -d "$AUTOINIT_TEST/projections"
assert "auto-init creates config.json via gc-hook" test -f "$AUTOINIT_TEST/config.json"

# Test 8: Auto-init with custom CLAUDE_CONTEXT_PATH
CUSTOM_TEST="$TEST_DIR/custom-init-test"
export CLAUDE_CONTEXT_PATH="$CUSTOM_TEST"
echo '{"session_id":"custom-init"}' | "$PLUGIN_DIR/scripts/gc-hook" SessionStarted 2>/dev/null
assert "auto-init works at custom CLAUDE_CONTEXT_PATH" test -d "$CUSTOM_TEST/events"

# Test 9: gc-hook still exits 0 even if gc-init fails (read-only dir simulation)
READONLY_TEST="$TEST_DIR/readonly-test"
mkdir -p "$READONLY_TEST"
chmod 000 "$READONLY_TEST" 2>/dev/null || true
export CLAUDE_CONTEXT_PATH="$READONLY_TEST"
EXIT_CODE=0
echo '{}' | "$PLUGIN_DIR/scripts/gc-hook" TestEvent 2>/dev/null || EXIT_CODE=$?
chmod 755 "$READONLY_TEST" 2>/dev/null || true
assert_eq "gc-hook exits 0 even when gc-init fails" "0" "$EXIT_CODE"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
