#!/usr/bin/env bash
set -euo pipefail

# test_gc_uninstall.sh -- Tests for gc-uninstall script

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GC_INSTALL="$PROJECT_ROOT/src/bin/gc-install"
GC_UNINSTALL="$PROJECT_ROOT/src/bin/gc-uninstall"

RESULT_FILE=$(mktemp)
echo "0 0" > "$RESULT_FILE"

cleanup() {
  rm -f "$RESULT_FILE"
}
trap cleanup EXIT

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

assert_file_exists() {
  local label="$1"
  local path="$2"
  if [ -f "$path" ]; then
    echo "  PASS: $label"
    _record_pass
  else
    echo "  FAIL: $label (file not found: $path)"
    _record_fail
  fi
}

assert_file_not_exists() {
  local label="$1"
  local path="$2"
  if [ ! -f "$path" ]; then
    echo "  PASS: $label"
    _record_pass
  else
    echo "  FAIL: $label (file should not exist: $path)"
    _record_fail
  fi
}

assert_dir_exists() {
  local label="$1"
  local path="$2"
  if [ -d "$path" ]; then
    echo "  PASS: $label"
    _record_pass
  else
    echo "  FAIL: $label (dir not found: $path)"
    _record_fail
  fi
}

assert_dir_not_exists() {
  local label="$1"
  local path="$2"
  if [ ! -d "$path" ]; then
    echo "  PASS: $label"
    _record_pass
  else
    echo "  FAIL: $label (dir should not exist: $path)"
    _record_fail
  fi
}

# Helper: install to a temp dir
_do_install() {
  local tmpdir="$1"
  export CLAUDE_CONTEXT_PATH="$tmpdir/gc-store"
  export HOME="$tmpdir/home"
  mkdir -p "$HOME/.claude"
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1
}

# ===================================================================
echo "=== Test Group 1: Soft uninstall (default) ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  _do_install "$TEST_TMPDIR"

  # Create some fake event data
  mkdir -p "$TEST_TMPDIR/gc-store/events/proj-abc123/sess-001"
  echo '{"test":true}' > "$TEST_TMPDIR/gc-store/events/proj-abc123/sess-001/000001.json"

  output=$(bash "$GC_UNINSTALL" 2>&1)

  # bin/ and lib/ should be removed
  assert_dir_not_exists "bin/ removed" "$TEST_TMPDIR/gc-store/bin"
  assert_dir_not_exists "lib/ removed" "$TEST_TMPDIR/gc-store/lib"
  assert_file_not_exists "VERSION removed" "$TEST_TMPDIR/gc-store/VERSION"

  # events/ and config.json should be preserved
  assert_dir_exists "events/ preserved" "$TEST_TMPDIR/gc-store/events"
  assert_file_exists "config.json preserved" "$TEST_TMPDIR/gc-store/config.json"
  assert_file_exists "event data preserved" "$TEST_TMPDIR/gc-store/events/proj-abc123/sess-001/000001.json"

  assert_contains "output mentions preserved" "$output" "Data preserved"

  rm -rf "$TEST_TMPDIR"
)

# ===================================================================
echo ""
echo "=== Test Group 2: Purge with --force ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  _do_install "$TEST_TMPDIR"

  # Create fake event data
  mkdir -p "$TEST_TMPDIR/gc-store/events/proj-abc123/sess-001"
  echo '{"test":true}' > "$TEST_TMPDIR/gc-store/events/proj-abc123/sess-001/000001.json"

  output=$(bash "$GC_UNINSTALL" --purge --force 2>&1)

  # Everything should be gone
  assert_dir_not_exists "store root removed" "$TEST_TMPDIR/gc-store"

  assert_contains "output mentions data deleted" "$output" "Data deleted"

  rm -rf "$TEST_TMPDIR"
)

# ===================================================================
echo ""
echo "=== Test Group 3: Purge without --force requires confirmation ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  _do_install "$TEST_TMPDIR"

  # Pipe "no" to stdin
  output=$(echo "no" | bash "$GC_UNINSTALL" --purge 2>&1) || true

  # Nothing should be removed
  assert_dir_exists "store still exists after declining" "$TEST_TMPDIR/gc-store"
  assert_contains "output mentions aborted" "$output" "Aborted"

  rm -rf "$TEST_TMPDIR"
)

# ===================================================================
echo ""
echo "=== Test Group 4: --dry-run makes no changes ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  _do_install "$TEST_TMPDIR"

  output=$(bash "$GC_UNINSTALL" --dry-run 2>&1)

  # Everything should still exist
  assert_dir_exists "bin/ still exists" "$TEST_TMPDIR/gc-store/bin"
  assert_dir_exists "lib/ still exists" "$TEST_TMPDIR/gc-store/lib"
  assert_file_exists "VERSION still exists" "$TEST_TMPDIR/gc-store/VERSION"
  assert_contains "output mentions dry run" "$output" "Dry run"

  rm -rf "$TEST_TMPDIR"
)

# ===================================================================
echo ""
echo "=== Test Group 5: Uninstall on non-installed system ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$TEST_TMPDIR/nonexistent-store"
  export HOME="$TEST_TMPDIR/home"
  mkdir -p "$HOME"

  output=$(bash "$GC_UNINSTALL" 2>&1)
  exit_code=$?

  assert_eq "exits 0 on non-installed system" "0" "$exit_code"
  assert_contains "output says not installed" "$output" "not installed"

  rm -rf "$TEST_TMPDIR"
)

# ===================================================================
echo ""
echo "=== Test Group 6: Reinstall after soft uninstall preserves data ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  _do_install "$TEST_TMPDIR"

  # Create fake event data
  mkdir -p "$TEST_TMPDIR/gc-store/events/proj-abc123/sess-001"
  echo '{"test":"preserved"}' > "$TEST_TMPDIR/gc-store/events/proj-abc123/sess-001/000001.json"

  # Soft uninstall
  bash "$GC_UNINSTALL" >/dev/null 2>&1

  # Reinstall
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1

  # Verify event data survived
  assert_file_exists "event data survives reinstall" "$TEST_TMPDIR/gc-store/events/proj-abc123/sess-001/000001.json"
  content=$(cat "$TEST_TMPDIR/gc-store/events/proj-abc123/sess-001/000001.json")
  assert_contains "event content preserved" "$content" "preserved"

  rm -rf "$TEST_TMPDIR"
)

# ===================================================================
echo ""
echo "=== Test Group 7: Reinstall after purge is fresh install ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  _do_install "$TEST_TMPDIR"

  # Purge
  bash "$GC_UNINSTALL" --purge --force >/dev/null 2>&1

  # Reinstall
  output=$(bash "$GC_INSTALL" --skip-hooks 2>&1)

  assert_dir_exists "fresh install after purge" "$TEST_TMPDIR/gc-store"
  assert_file_exists "VERSION after fresh install" "$TEST_TMPDIR/gc-store/VERSION"
  assert_contains "fresh install message" "$output" "Installation complete!"

  rm -rf "$TEST_TMPDIR"
)

# ===================================================================
echo ""
# Summary
# ===================================================================
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
