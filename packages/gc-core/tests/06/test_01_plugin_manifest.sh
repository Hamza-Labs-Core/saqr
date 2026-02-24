#!/usr/bin/env bash
# Test: Task 01 - Plugin Manifest and Directory Scaffold
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLUGIN_DIR="$PROJECT_DIR/plugin"

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

# Test 1: plugin.json exists and is valid JSON
assert "plugin.json exists and is valid JSON" jq . "$PLUGIN_DIR/.claude-plugin/plugin.json"

# Test 2: name field is "globalcontext"
NAME=$(jq -r .name "$PLUGIN_DIR/.claude-plugin/plugin.json")
assert_eq "plugin name is globalcontext" "globalcontext" "$NAME"

# Test 3: version field exists
VERSION=$(jq -r .version "$PLUGIN_DIR/.claude-plugin/plugin.json")
assert_eq "plugin version is 1.0.0" "1.0.0" "$VERSION"

# Test 4: All six subdirectories exist
assert "commands/ directory exists" test -d "$PLUGIN_DIR/commands"
assert "agents/ directory exists" test -d "$PLUGIN_DIR/agents"
assert "skills/ directory exists" test -d "$PLUGIN_DIR/skills"
assert "hooks/ directory exists" test -d "$PLUGIN_DIR/hooks"
assert "scripts/ directory exists" test -d "$PLUGIN_DIR/scripts"
assert "lib/ directory exists" test -d "$PLUGIN_DIR/lib"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
