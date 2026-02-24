#!/usr/bin/env bash
# Test: Task 09 - Marketplace Configuration
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

# Test 1: marketplace.json is valid JSON
assert "marketplace.json is valid JSON" jq . "$PLUGIN_DIR/marketplace.json"

# Test 2: marketplace.json fields
NAME=$(jq -r '.name' "$PLUGIN_DIR/marketplace.json")
assert_eq "marketplace name is globalcontext" "globalcontext" "$NAME"

VERSION=$(jq -r '.version' "$PLUGIN_DIR/marketplace.json")
assert_eq "marketplace version is 1.0.0" "1.0.0" "$VERSION"

INSTALL_PATH=$(jq -r '.install.path' "$PLUGIN_DIR/marketplace.json")
assert_eq "install.path is plugin" "plugin" "$INSTALL_PATH"

INSTALL_TYPE=$(jq -r '.install.type' "$PLUGIN_DIR/marketplace.json")
assert_eq "install.type is git" "git" "$INSTALL_TYPE"

LICENSE=$(jq -r '.license' "$PLUGIN_DIR/marketplace.json")
assert_eq "license is MIT" "MIT" "$LICENSE"

# Test 3: keywords and categories
KEYWORD_COUNT=$(jq '.keywords | length' "$PLUGIN_DIR/marketplace.json")
assert "marketplace has keywords" test "$KEYWORD_COUNT" -gt 0

CAT_COUNT=$(jq '.categories | length' "$PLUGIN_DIR/marketplace.json")
assert "marketplace has categories" test "$CAT_COUNT" -gt 0

# Test 4: README.md exists and documents all 9 commands
assert "README.md exists" test -f "$PLUGIN_DIR/README.md"
for cmd in last session sessions search replay tail events status doctor; do
  assert "README documents /globalcontext:$cmd" grep -q "globalcontext:$cmd" "$PLUGIN_DIR/README.md"
done

# Test 5: CHANGELOG.md exists with 1.0.0 entry
assert "CHANGELOG.md exists" test -f "$PLUGIN_DIR/CHANGELOG.md"
assert "CHANGELOG has 1.0.0 entry" grep -q '1.0.0' "$PLUGIN_DIR/CHANGELOG.md"

# Test 6: LICENSE exists with MIT text
assert "LICENSE exists" test -f "$PLUGIN_DIR/LICENSE"
assert "LICENSE contains MIT" grep -q 'MIT' "$PLUGIN_DIR/LICENSE"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
