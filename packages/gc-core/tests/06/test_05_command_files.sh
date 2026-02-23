#!/usr/bin/env bash
# Test: Task 05 - Command Files (Slash Commands)
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLUGIN_DIR="$PROJECT_DIR/plugin"
CMD_DIR="$PLUGIN_DIR/commands"

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

# Expected command files
COMMANDS=(last session sessions search replay tail events status doctor)

# Test 1: All 9 command files exist
for cmd in "${COMMANDS[@]}"; do
  assert "commands/$cmd.md exists" test -f "$CMD_DIR/$cmd.md"
done

# Test 2: Each file has valid YAML frontmatter with name and description
for cmd in "${COMMANDS[@]}"; do
  FILE="$CMD_DIR/$cmd.md"

  # Check frontmatter starts with ---
  FIRST_LINE=$(head -1 "$FILE")
  assert_eq "$cmd.md starts with ---" "---" "$FIRST_LINE"

  # Check name field exists in frontmatter
  NAME=$(sed -n '/^---$/,/^---$/p' "$FILE" | grep '^name:' | sed 's/^name: *//')
  assert "$cmd.md has name field in frontmatter" test -n "$NAME"

  # Check description field exists in frontmatter
  DESC=$(sed -n '/^---$/,/^---$/p' "$FILE" | grep '^description:' | sed 's/^description: *//')
  assert "$cmd.md has description field in frontmatter" test -n "$DESC"
done

# Test 3: Each file references gc-query
for cmd in "${COMMANDS[@]}"; do
  assert "$cmd.md references gc-query" grep -q 'gc-query' "$CMD_DIR/$cmd.md"
done

# Test 4: Each file references CLAUDE_PLUGIN_ROOT
for cmd in "${COMMANDS[@]}"; do
  assert "$cmd.md references CLAUDE_PLUGIN_ROOT" grep -q 'CLAUDE_PLUGIN_ROOT' "$CMD_DIR/$cmd.md"
done

# Test 5: Total count is exactly 9 (plus .gitkeep)
CMD_COUNT=$(find "$CMD_DIR" -name '*.md' | wc -l)
assert_eq "exactly 9 command files" "9" "$CMD_COUNT"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
