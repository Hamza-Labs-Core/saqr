#!/usr/bin/env bash
# Test: Task 02 - Hook Configuration (hooks.json)
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLUGIN_DIR="$PROJECT_DIR/plugin"
HOOKS_FILE="$PLUGIN_DIR/hooks/hooks.json"

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

# Test 1: hooks.json is valid JSON
assert "hooks.json is valid JSON" jq . "$HOOKS_FILE"

# Test 2: 10 hook events
COUNT=$(jq '.hooks | keys | length' "$HOOKS_FILE")
assert_eq "hooks.json has 10 hook events" "10" "$COUNT"

# Test 3: Sync events have async: false
for event in SessionStart UserPromptSubmit PreCompact; do
  ASYNC=$(jq -r ".hooks.${event}[0].hooks[0].async" "$HOOKS_FILE")
  assert_eq "$event has async=false" "false" "$ASYNC"
done

# Test 4: Async events have async: true
for event in PreToolUse PostToolUse PostToolUseFailure SubagentStart SubagentStop Stop SessionEnd; do
  ASYNC=$(jq -r ".hooks.${event}[0].hooks[0].async" "$HOOKS_FILE")
  assert_eq "$event has async=true" "true" "$ASYNC"
done

# Test 5: All commands reference gc-hook
ALL_COMMANDS=$(jq -r '[.hooks[][] | .hooks[].command] | unique | .[]' "$HOOKS_FILE")
REFS_GC_HOOK=true
while IFS= read -r cmd; do
  if [[ "$cmd" != *'${CLAUDE_PLUGIN_ROOT}/scripts/gc-hook'* ]]; then
    REFS_GC_HOOK=false
    break
  fi
done <<< "$ALL_COMMANDS"
assert "all commands reference gc-hook" $REFS_GC_HOOK

# Test 6: Tool-related hooks have matcher ".*"
for event in PreToolUse PostToolUse PostToolUseFailure SubagentStart SubagentStop; do
  MATCHER=$(jq -r ".hooks.${event}[0].matcher" "$HOOKS_FILE")
  assert_eq "$event has matcher '.*'" ".*" "$MATCHER"
done

# Test 7: All timeouts are 5000
TIMEOUTS=$(jq -c '[.hooks[][] | .hooks[].timeout] | unique' "$HOOKS_FILE")
assert_eq "all timeouts are [5000]" "[5000]" "$TIMEOUTS"

# Test 8: All hooks have type "command"
TYPES=$(jq -c '[.hooks[][] | .hooks[].type] | unique' "$HOOKS_FILE")
assert_eq "all types are [\"command\"]" "[\"command\"]" "$TYPES"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
