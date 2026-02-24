#!/usr/bin/env bash
# Test: Task 07 - Context Recovery Agent
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLUGIN_DIR="$PROJECT_DIR/plugin"
AGENT_FILE="$PLUGIN_DIR/agents/context-investigator.md"

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

# Test 1: Agent file exists
assert "context-investigator.md exists" test -f "$AGENT_FILE"

# Test 2: Has valid frontmatter
FIRST_LINE=$(head -1 "$AGENT_FILE")
assert_eq "starts with ---" "---" "$FIRST_LINE"

# Test 3: Has name: context-investigator
NAME=$(sed -n '/^---$/,/^---$/p' "$AGENT_FILE" | grep '^name:' | sed 's/^name: *//')
assert_eq "name is context-investigator" "context-investigator" "$NAME"

# Test 4: Has description field
DESC=$(sed -n '/^---$/,/^---$/p' "$AGENT_FILE" | grep '^description:' | head -1)
assert "has description field" test -n "$DESC"

# Test 5: Lists all gc-query subcommands
assert "references sessions subcommand" grep -q 'gc-query.*sessions' "$AGENT_FILE"
assert "references session subcommand" grep -q 'gc-query.*session' "$AGENT_FILE"
assert "references search subcommand" grep -q 'gc-query.*search' "$AGENT_FILE"
assert "references replay subcommand" grep -q 'gc-query.*replay' "$AGENT_FILE"
assert "references events subcommand" grep -q 'gc-query.*events' "$AGENT_FILE"
assert "references tail subcommand" grep -q 'gc-query.*tail' "$AGENT_FILE"

# Test 6: References CLAUDE_PLUGIN_ROOT for all commands
PLUGIN_REF_COUNT=$(grep -c 'CLAUDE_PLUGIN_ROOT.*gc-query' "$AGENT_FILE")
assert "references CLAUDE_PLUGIN_ROOT/scripts/gc-query at least 6 times" test "$PLUGIN_REF_COUNT" -ge 6

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
