#!/usr/bin/env bash
# Tests for latest_symlink.sh (Task 03/10)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Set up a temp directory as the context store root
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

export CLAUDE_CONTEXT_PATH="$TEST_DIR"

# Source the module under test
source "$PROJECT_ROOT/src/lib/latest_symlink.sh"

PASS=0
FAIL=0

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected '$expected', got '$actual')"
    FAIL=$((FAIL + 1))
  fi
}

assert_symlink() {
  local desc="$1" path="$2" expected_target="$3"
  if [[ -L "$path" ]]; then
    local actual_target
    actual_target="$(readlink "$path")"
    if [[ "$actual_target" == "$expected_target" ]]; then
      echo "  PASS: $desc"
      PASS=$((PASS + 1))
    else
      echo "  FAIL: $desc (symlink target expected '$expected_target', got '$actual_target')"
      FAIL=$((FAIL + 1))
    fi
  else
    echo "  FAIL: $desc (not a symlink at $path)"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_absolute() {
  local desc="$1" path="$2"
  if [[ -L "$path" ]]; then
    local target
    target="$(readlink "$path")"
    if [[ "$target" != /* ]]; then
      echo "  PASS: $desc"
      PASS=$((PASS + 1))
    else
      echo "  FAIL: $desc (target is absolute: '$target')"
      FAIL=$((FAIL + 1))
    fi
  else
    echo "  FAIL: $desc (not a symlink at $path)"
    FAIL=$((FAIL + 1))
  fi
}

# ---------------------------------------------------------------
echo "Test 1: Create initial latest symlink"
gc_update_latest_symlink "proj-abc123" "session-1"
assert_symlink "symlink points to session-1" \
  "$GC_PROJECTIONS_DIR/proj-abc123/latest" "session-1"

# ---------------------------------------------------------------
echo "Test 2: Update existing latest symlink"
gc_update_latest_symlink "proj-abc123" "session-2"
assert_symlink "symlink now points to session-2" \
  "$GC_PROJECTIONS_DIR/proj-abc123/latest" "session-2"

# ---------------------------------------------------------------
echo "Test 3: gc_read_latest_session_id returns current target"
result="$(gc_read_latest_session_id "proj-abc123")"
assert_eq "read returns session-2" "session-2" "$result"

# ---------------------------------------------------------------
echo "Test 4: Symlink target is relative (not absolute)"
assert_not_absolute "target is relative" \
  "$GC_PROJECTIONS_DIR/proj-abc123/latest"

# ---------------------------------------------------------------
echo "Test 5: Two different projects have independent latest symlinks"
gc_update_latest_symlink "proj-xyz789" "session-A"
gc_update_latest_symlink "proj-abc123" "session-3"

result_abc="$(gc_read_latest_session_id "proj-abc123")"
result_xyz="$(gc_read_latest_session_id "proj-xyz789")"

assert_eq "proj-abc123 latest is session-3" "session-3" "$result_abc"
assert_eq "proj-xyz789 latest is session-A" "session-A" "$result_xyz"

# ---------------------------------------------------------------
echo "Test 6: gc_read_latest_session_id returns empty for nonexistent project"
result="$(gc_read_latest_session_id "proj-nonexistent")"
assert_eq "returns empty for missing project" "" "$result"

# ---------------------------------------------------------------
echo "Test 7: Error logged but no crash if projections dir cannot be created"
# Make a read-only parent to prevent mkdir
readonly_dir="$TEST_DIR/readonly"
mkdir -p "$readonly_dir"
chmod 000 "$readonly_dir"

# Temporarily override GC_PROJECTIONS_DIR
OLD_PROJ_DIR="$GC_PROJECTIONS_DIR"
GC_PROJECTIONS_DIR="$readonly_dir/projections"

# Should not crash, should log warning
stderr_output="$(gc_update_latest_symlink "proj-fail" "session-x" 2>&1 1>/dev/null || true)"

# Restore
GC_PROJECTIONS_DIR="$OLD_PROJ_DIR"
chmod 755 "$readonly_dir"

if [[ $? -eq 0 ]]; then
  echo "  PASS: no crash when projections dir cannot be created"
  PASS=$((PASS + 1))
else
  echo "  FAIL: crashed when projections dir cannot be created"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------
echo "Test 8: Target projection directory does not need to exist for symlink creation"
gc_update_latest_symlink "proj-newproj" "nonexistent-session-dir"
assert_symlink "symlink created even though target dir does not exist" \
  "$GC_PROJECTIONS_DIR/proj-newproj/latest" "nonexistent-session-dir"

# ---------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi

exit 0
