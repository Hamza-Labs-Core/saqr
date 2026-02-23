#!/usr/bin/env bash
set -euo pipefail

# test_paths.sh -- Unit tests for src/lib/paths.sh
# Exit 0 on success, non-zero on failure.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PATHS_SH="$PROJECT_ROOT/src/lib/paths.sh"

# Use temp files to track pass/fail across subshells
RESULT_FILE=$(mktemp)
echo "0 0" > "$RESULT_FILE"
trap 'rm -f "$RESULT_FILE"' EXIT

_record_pass() {
  local counts
  counts=$(cat "$RESULT_FILE")
  local p f
  p=$(echo "$counts" | cut -d' ' -f1)
  f=$(echo "$counts" | cut -d' ' -f2)
  echo "$((p + 1)) $f" > "$RESULT_FILE"
}

_record_fail() {
  local counts
  counts=$(cat "$RESULT_FILE")
  local p f
  p=$(echo "$counts" | cut -d' ' -f1)
  f=$(echo "$counts" | cut -d' ' -f2)
  echo "$p $((f + 1))" > "$RESULT_FILE"
}

assert_eq() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS: $label"
    _record_pass
  else
    echo "  FAIL: $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    _record_fail
  fi
}

assert_contains() {
  local label="$1"
  local haystack="$2"
  local needle="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    echo "  PASS: $label"
    _record_pass
  else
    echo "  FAIL: $label"
    echo "    expected to contain: $needle"
    echo "    actual:              $haystack"
    _record_fail
  fi
}

assert_not_zero_exit() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "  FAIL: $label (expected non-zero exit, got 0)"
    _record_fail
  else
    echo "  PASS: $label"
    _record_pass
  fi
}

# ===================================================================
echo "=== Test Group 1: Default GC_ROOT (CLAUDE_CONTEXT_PATH unset) ==="
# ===================================================================
(
  unset CLAUDE_CONTEXT_PATH 2>/dev/null || true
  source "$PATHS_SH"
  assert_eq "GC_ROOT defaults to \$HOME/.claude-context" \
    "$HOME/.claude-context" "$GC_ROOT"
  assert_eq "GC_EVENTS_DIR derived from GC_ROOT" \
    "$HOME/.claude-context/events" "$GC_EVENTS_DIR"
  assert_eq "GC_PROJECTIONS_DIR derived from GC_ROOT" \
    "$HOME/.claude-context/projections" "$GC_PROJECTIONS_DIR"
  assert_eq "GC_BIN_DIR derived from GC_ROOT" \
    "$HOME/.claude-context/bin" "$GC_BIN_DIR"
  assert_eq "GC_CONFIG_FILE derived from GC_ROOT" \
    "$HOME/.claude-context/config.json" "$GC_CONFIG_FILE"
)

# ===================================================================
echo ""
echo "=== Test Group 2: Custom CLAUDE_CONTEXT_PATH ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="/tmp/test-store"
  source "$PATHS_SH"
  assert_eq "GC_ROOT respects CLAUDE_CONTEXT_PATH" \
    "/tmp/test-store" "$GC_ROOT"
  assert_eq "GC_EVENTS_DIR uses custom root" \
    "/tmp/test-store/events" "$GC_EVENTS_DIR"
  assert_eq "GC_PROJECTIONS_DIR uses custom root" \
    "/tmp/test-store/projections" "$GC_PROJECTIONS_DIR"
  assert_eq "GC_BIN_DIR uses custom root" \
    "/tmp/test-store/bin" "$GC_BIN_DIR"
  assert_eq "GC_CONFIG_FILE uses custom root" \
    "/tmp/test-store/config.json" "$GC_CONFIG_FILE"
)

# ===================================================================
echo ""
echo "=== Test Group 3: gc_session_events_dir ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="/tmp/gc-test"
  source "$PATHS_SH"
  result=$(gc_session_events_dir "myproj-abc123" "sess-001")
  assert_eq "session events dir with simple IDs" \
    "/tmp/gc-test/events/myproj-abc123/sess-001" "$result"
)

# ===================================================================
echo ""
echo "=== Test Group 4: gc_session_lock_file ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="/tmp/gc-test"
  source "$PATHS_SH"
  result=$(gc_session_lock_file "myproj-abc123" "sess-001")
  assert_eq "session lock file path" \
    "/tmp/gc-test/events/myproj-abc123/sess-001/.lock" "$result"
)

# ===================================================================
echo ""
echo "=== Test Group 5: gc_session_projections_dir ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="/tmp/gc-test"
  source "$PATHS_SH"
  result=$(gc_session_projections_dir "myproj-abc123" "sess-001")
  assert_eq "session projections dir" \
    "/tmp/gc-test/projections/myproj-abc123/sess-001" "$result"
)

# ===================================================================
echo ""
echo "=== Test Group 6: gc_project_latest ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="/tmp/gc-test"
  source "$PATHS_SH"
  result=$(gc_project_latest "myproj-abc123")
  assert_eq "project latest symlink path" \
    "/tmp/gc-test/projections/myproj-abc123/latest" "$result"
)

# ===================================================================
echo ""
echo "=== Test Group 7: gc_resolve_root ==="
# ===================================================================
(
  # Test with a non-existent directory -- should fail
  export CLAUDE_CONTEXT_PATH="/tmp/gc-test-nonexistent-$$"
  source "$PATHS_SH"
  assert_not_zero_exit "gc_resolve_root fails when store does not exist" \
    gc_resolve_root
)
(
  # Test with an existing directory -- should succeed
  test_dir="/tmp/gc-test-exists-$$"
  mkdir -p "$test_dir"
  export CLAUDE_CONTEXT_PATH="$test_dir"
  source "$PATHS_SH"
  result=$(gc_resolve_root)
  assert_eq "gc_resolve_root returns root when store exists" \
    "$test_dir" "$result"
  rmdir "$test_dir"
)

# ===================================================================
echo ""
echo "=== Test Group 8: gc_derive_project_id ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="/tmp/gc-test"
  source "$PATHS_SH"

  # Empty input -> _unknown-000000
  result=$(gc_derive_project_id "")
  assert_eq "empty project_dir -> _unknown-000000" \
    "_unknown-000000" "$result"

  # Normal path
  result=$(gc_derive_project_id "/home/user/my-project")
  expected_hash=$(printf '%s' "/home/user/my-project" | sha256sum | cut -c1-6)
  assert_eq "normal path basename-hash6" \
    "my-project-${expected_hash}" "$result"

  # Same basename, different path -> different hash
  result1=$(gc_derive_project_id "/home/user/my-project")
  result2=$(gc_derive_project_id "/home/user/work/my-project")
  if [ "$result1" != "$result2" ]; then
    echo "  PASS: same basename different path -> different project_id"
    _record_pass
  else
    echo "  FAIL: same basename different path -> should differ"
    echo "    result1: $result1"
    echo "    result2: $result2"
    _record_fail
  fi

  # Verify basename extraction
  result=$(gc_derive_project_id "/tmp/test")
  assert_contains "project_id starts with basename" "$result" "test-"

  # Verify hash is 6 hex chars
  hash_part="${result##*-}"
  if echo "$hash_part" | grep -qE '^[0-9a-f]{6}$'; then
    echo "  PASS: hash part is exactly 6 hex chars"
    _record_pass
  else
    echo "  FAIL: hash part should be 6 hex chars, got: $hash_part"
    _record_fail
  fi
)

# ===================================================================
echo ""
echo "=== Test Group 9: Session ID sanitization ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="/tmp/gc-test"
  source "$PATHS_SH"

  # Session ID with special chars should be sanitized
  result=$(gc_session_events_dir "proj-abc123" "sess/../../etc/passwd")
  assert_eq "session_id with path traversal is sanitized" \
    "/tmp/gc-test/events/proj-abc123/sessetcpasswd" "$result"

  result=$(gc_session_events_dir "proj-abc123" "normal-session_123")
  assert_eq "clean session_id passes through" \
    "/tmp/gc-test/events/proj-abc123/normal-session_123" "$result"
)

# ===================================================================
echo ""
echo "=== Test Group 10: No hardcoded ~/.claude-context in paths.sh ==="
# ===================================================================
(
  # The only allowed reference to .claude-context is in the GC_ROOT default
  # assignment line: GC_ROOT="${CLAUDE_CONTEXT_PATH:-$HOME/.claude-context}"
  # All other non-comment lines must NOT reference it.
  hardcoded=$(grep -v '^\s*#' "$PATHS_SH" | grep -v '^GC_ROOT=' | grep -c '\.claude-context' || true)
  if [ "$hardcoded" -eq 0 ]; then
    echo "  PASS: no hardcoded ~/.claude-context outside GC_ROOT assignment"
    _record_pass
  else
    echo "  FAIL: found $hardcoded hardcoded references to .claude-context outside GC_ROOT assignment"
    _record_fail
  fi
)

# ===================================================================
echo ""
echo "=== Test Group 11: gc_derive_project_id with root path (/) ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="/tmp/gc-test"
  source "$PATHS_SH"

  # basename of "/" is "/" which sanitizes to empty -> "_root"
  result=$(gc_derive_project_id "/")
  assert_contains "root path uses _root basename" "$result" "_root-"
)

# ===================================================================
# Summary
# ===================================================================
echo ""
counts=$(cat "$RESULT_FILE")
PASS=$(echo "$counts" | cut -d' ' -f1)
FAIL=$(echo "$counts" | cut -d' ' -f2)

echo "=============================="
echo "Results: $PASS passed, $FAIL failed"
echo "=============================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
