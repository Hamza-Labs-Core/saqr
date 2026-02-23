#!/usr/bin/env bash
# Test: Task 03 - Capture Event Script Adaptation
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLUGIN_DIR="$PROJECT_DIR/plugin"

TEST_DIR=$(mktemp -d)
export CLAUDE_CONTEXT_PATH="$TEST_DIR/store"
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

# Test 1: gc-hook is executable
assert "gc-hook is executable" test -x "$PLUGIN_DIR/scripts/gc-hook"

# Test 2: capture-event is executable
assert "capture-event is executable" test -x "$PLUGIN_DIR/scripts/capture-event"

# Test 3: gc-hook exits 0 with valid input
mkdir -p "$CLAUDE_CONTEXT_PATH/events"
RESULT=$(echo '{"session_id":"test-s1"}' | "$PLUGIN_DIR/scripts/gc-hook" SessionStarted 2>&1; echo "EXIT:$?")
EXIT_CODE=$(echo "$RESULT" | grep -o 'EXIT:[0-9]*' | cut -d: -f2)
assert_eq "gc-hook exits 0 with valid input" "0" "$EXIT_CODE"

# Test 4: gc-hook produces zero stdout
STDOUT=$(echo '{"session_id":"test-s2"}' | "$PLUGIN_DIR/scripts/gc-hook" TestEvent 2>/dev/null)
assert_eq "gc-hook produces zero stdout" "" "$STDOUT"

# Test 5: gc-hook produces zero stderr (non-debug)
STDERR=$(echo '{"session_id":"test-s3"}' | GC_DEBUG=0 "$PLUGIN_DIR/scripts/gc-hook" TestEvent 2>&1 >/dev/null)
assert_eq "gc-hook produces zero stderr" "" "$STDERR"

# Test 6: gc-hook exits 0 even with broken capture-event
(
  # Create a temp dir to simulate broken capture-event
  BROKEN_DIR=$(mktemp -d)
  mkdir -p "$BROKEN_DIR/scripts" "$BROKEN_DIR/lib"
  cp "$PLUGIN_DIR/scripts/gc-hook" "$BROKEN_DIR/scripts/"
  cp "$PLUGIN_DIR/lib/paths.sh" "$BROKEN_DIR/lib/"
  cp "$PLUGIN_DIR/lib/debug_log.sh" "$BROKEN_DIR/lib/"
  # Don't copy capture-event -- it should fail gracefully
  echo '{}' | "$BROKEN_DIR/scripts/gc-hook" TestEvent 2>/dev/null
  exit_code=$?
  rm -rf "$BROKEN_DIR"
  exit $exit_code
)
assert "gc-hook exits 0 when capture-event is missing" test $? -eq 0

# Test 7: capture-event writes an event to the store
rm -rf "$CLAUDE_CONTEXT_PATH"
mkdir -p "$CLAUDE_CONTEXT_PATH/events"
echo '{"session_id":"cap-test-1"}' | "$PLUGIN_DIR/scripts/capture-event" SessionStarted
EVENT_FILES=$(find "$CLAUDE_CONTEXT_PATH/events" -name '*.json' -not -name 'session.json' -not -name '.lock' | head -1)
assert "capture-event writes event file" test -n "$EVENT_FILES"

# Test 8: Written event has correct event_type
if [ -n "$EVENT_FILES" ]; then
  ETYPE=$(jq -r '.event_type' "$EVENT_FILES")
  assert_eq "event has correct event_type" "SessionStarted" "$ETYPE"
fi

# Test 9: No hardcoded paths in scripts
NO_HARDCODED=true
for script in "$PLUGIN_DIR/scripts/gc-hook" "$PLUGIN_DIR/scripts/capture-event"; do
  if grep -q '~/.claude-context/bin/' "$script" 2>/dev/null || grep -q '\$HOME/.claude-context/bin/' "$script" 2>/dev/null; then
    NO_HARDCODED=false
  fi
done
assert "no hardcoded ~/.claude-context/bin/ paths in scripts" $NO_HARDCODED

# Test 10: CLAUDE_CONTEXT_PATH override works
rm -rf "$TEST_DIR/custom-store"
export CLAUDE_CONTEXT_PATH="$TEST_DIR/custom-store"
mkdir -p "$TEST_DIR/custom-store/events"
echo '{"session_id":"custom-test"}' | "$PLUGIN_DIR/scripts/capture-event" SessionStarted
assert "CLAUDE_CONTEXT_PATH override creates event at custom path" test -d "$TEST_DIR/custom-store/events"
CUSTOM_EVENTS=$(find "$TEST_DIR/custom-store/events" -name '*.json' -not -name 'session.json' 2>/dev/null | head -1)
assert "event file exists at custom path" test -n "$CUSTOM_EVENTS"

# Test 11: Scripts work from arbitrary plugin location
ARBITRARY_DIR=$(mktemp -d)
cp -r "$PLUGIN_DIR"/* "$ARBITRARY_DIR/"
chmod +x "$ARBITRARY_DIR/scripts/gc-hook" "$ARBITRARY_DIR/scripts/capture-event"
ARBIT_STORE=$(mktemp -d)
mkdir -p "$ARBIT_STORE/events"
export CLAUDE_CONTEXT_PATH="$ARBIT_STORE"
echo '{"session_id":"arb-test"}' | "$ARBITRARY_DIR/scripts/gc-hook" SessionStarted 2>/dev/null
ARB_EVENTS=$(find "$ARBIT_STORE/events" -name '*.json' -not -name 'session.json' 2>/dev/null | head -1)
assert "scripts work from arbitrary plugin location" test -n "$ARB_EVENTS"
rm -rf "$ARBITRARY_DIR" "$ARBIT_STORE"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
