#!/usr/bin/env bash
# Test: Task 06 - Context Recovery Skill
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLUGIN_DIR="$PROJECT_DIR/plugin"
SKILL_FILE="$PLUGIN_DIR/skills/context-recovery/SKILL.md"

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

# Test 1: SKILL.md exists
assert "SKILL.md exists" test -f "$SKILL_FILE"

# Test 2: Has valid frontmatter
FIRST_LINE=$(head -1 "$SKILL_FILE")
assert_eq "SKILL.md starts with ---" "---" "$FIRST_LINE"

# Test 3: Has name: context-recovery
NAME=$(sed -n '/^---$/,/^---$/p' "$SKILL_FILE" | grep '^name:' | sed 's/^name: *//')
assert_eq "name is context-recovery" "context-recovery" "$NAME"

# Test 4: Has description field
DESC=$(sed -n '/^---$/,/^---$/p' "$SKILL_FILE" | grep '^description:' | head -1)
assert "has description field" test -n "$DESC"

# Test 5: Description contains trigger phrases
assert "description mentions 'what were we doing'" grep -qi 'what were we doing' "$SKILL_FILE"
assert "description mentions 'compaction'" grep -qi 'compaction' "$SKILL_FILE"
assert "description mentions 'continue'" grep -qi 'continue' "$SKILL_FILE"
assert "description mentions 'resume'" grep -qi 'resume' "$SKILL_FILE"
assert "description mentions 'new session'" grep -qi 'new session' "$SKILL_FILE"

# Test 6: References gc-query
assert "SKILL.md references gc-query" grep -q 'gc-query' "$SKILL_FILE"

# Test 7: References CLAUDE_PLUGIN_ROOT
assert "SKILL.md references CLAUDE_PLUGIN_ROOT" grep -q 'CLAUDE_PLUGIN_ROOT' "$SKILL_FILE"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
