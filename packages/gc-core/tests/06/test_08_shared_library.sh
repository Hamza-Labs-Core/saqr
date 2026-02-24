#!/usr/bin/env bash
# Test: Task 08 - Shared Library Bundling
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

# Test 1: All core library files exist
for lib in paths.sh sanitize.sh atomic_write.sh uuid.sh timestamp.sh debug_log.sh json_validate.sh session_dir.sh session_meta.sh event_write.sh; do
  assert "plugin/lib/$lib exists" test -f "$PLUGIN_DIR/lib/$lib"
done

# Test 2: Each bash library uses _LIB_DIR
for lib in paths.sh sanitize.sh atomic_write.sh uuid.sh timestamp.sh debug_log.sh json_validate.sh session_dir.sh session_meta.sh event_write.sh; do
  assert "plugin/lib/$lib uses _LIB_DIR" grep -q '_LIB_DIR' "$PLUGIN_DIR/lib/$lib"
done

# Test 3: paths.sh resolves GC_ROOT from CLAUDE_CONTEXT_PATH
(
  export CLAUDE_CONTEXT_PATH="/tmp/gc-lib-test"
  source "$PLUGIN_DIR/lib/paths.sh"
  [[ "$GC_ROOT" == "/tmp/gc-lib-test" ]]
)
assert "paths.sh resolves GC_ROOT from CLAUDE_CONTEXT_PATH" test $? -eq 0

# Test 4: paths.sh defaults to ~/.claude-context
(
  unset CLAUDE_CONTEXT_PATH
  source "$PLUGIN_DIR/lib/paths.sh"
  [[ "$GC_ROOT" == "$HOME/.claude-context" ]]
)
assert "paths.sh defaults to ~/.claude-context" test $? -eq 0

# Test 5: No hardcoded ~/.claude-context/bin/ paths in any library
NO_HARDCODED=true
for lib in "$PLUGIN_DIR"/lib/*.sh; do
  if grep -q '~/.claude-context/bin/' "$lib" 2>/dev/null; then
    NO_HARDCODED=false
    echo "  Found hardcoded path in: $lib"
  fi
  if grep -q '\$HOME/.claude-context/bin/' "$lib" 2>/dev/null; then
    NO_HARDCODED=false
    echo "  Found hardcoded path in: $lib"
  fi
done
assert "no hardcoded ~/.claude-context/bin/ paths in libraries" $NO_HARDCODED

# Test 6: gc-query script exists and is executable
assert "plugin/scripts/gc-query exists and is executable" test -x "$PLUGIN_DIR/scripts/gc-query"

# Test 7: gc-query sources from plugin lib
assert "gc-query sources from PLUGIN_ROOT/lib" grep -q 'PLUGIN_ROOT.*lib/paths.sh' "$PLUGIN_DIR/scripts/gc-query"

# Test 8: gc-query status runs without error from plugin
mkdir -p "$CLAUDE_CONTEXT_PATH/events"
assert "gc-query status runs from plugin scripts" "$PLUGIN_DIR/scripts/gc-query" status

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
