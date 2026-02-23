#!/usr/bin/env bash
set -euo pipefail

# test_gc_install_script.sh -- Tests for gc-install script

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GC_INSTALL="$PROJECT_ROOT/src/bin/gc-install"

RESULT_FILE=$(mktemp)
echo "0 0" > "$RESULT_FILE"
TEST_TMPDIR=""

cleanup() {
  rm -rf "$TEST_TMPDIR" 2>/dev/null || true
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

# ===================================================================
echo "=== Test Group 1: Fresh install on clean system ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$TEST_TMPDIR/gc-store"
  export HOME="$TEST_TMPDIR/home"
  mkdir -p "$HOME"

  output=$(bash "$GC_INSTALL" --skip-hooks 2>&1)

  assert_dir_exists "store dir created" "$TEST_TMPDIR/gc-store"
  assert_dir_exists "events/ created" "$TEST_TMPDIR/gc-store/events"
  assert_dir_exists "projections/ created" "$TEST_TMPDIR/gc-store/projections"
  assert_dir_exists "bin/ created" "$TEST_TMPDIR/gc-store/bin"
  assert_dir_exists "lib/ created" "$TEST_TMPDIR/gc-store/lib"
  assert_file_exists "VERSION created" "$TEST_TMPDIR/gc-store/VERSION"
  assert_file_exists "config.json created" "$TEST_TMPDIR/gc-store/config.json"
  assert_file_exists "gc-init installed" "$TEST_TMPDIR/gc-store/bin/gc-init"
  assert_file_exists "gc-query installed" "$TEST_TMPDIR/gc-store/bin/gc-query"
  assert_file_exists "paths.sh installed" "$TEST_TMPDIR/gc-store/lib/paths.sh"

  # Verify store permissions
  store_mode=$(stat -c '%a' "$TEST_TMPDIR/gc-store" 2>/dev/null || stat -f '%Lp' "$TEST_TMPDIR/gc-store" 2>/dev/null)
  assert_eq "store permissions are 700" "700" "$store_mode"

  assert_contains "output mentions complete" "$output" "Installation complete!"

  rm -rf "$TEST_TMPDIR"
)

# ===================================================================
echo ""
echo "=== Test Group 2: Repeat install detects same version ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$TEST_TMPDIR/gc-store"
  export HOME="$TEST_TMPDIR/home"
  mkdir -p "$HOME"

  # First install
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1

  # Second install
  output=$(bash "$GC_INSTALL" --skip-hooks 2>&1)
  assert_contains "detects same version" "$output" "Already up to date"

  rm -rf "$TEST_TMPDIR"
)

# ===================================================================
echo ""
echo "=== Test Group 3: Force reinstall ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$TEST_TMPDIR/gc-store"
  export HOME="$TEST_TMPDIR/home"
  mkdir -p "$HOME"

  # First install
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1

  # Force reinstall
  output=$(bash "$GC_INSTALL" --skip-hooks --force 2>&1)
  assert_contains "force reinstall proceeds" "$output" "Installation complete!"

  rm -rf "$TEST_TMPDIR"
)

# ===================================================================
echo ""
echo "=== Test Group 4: --skip-hooks does not touch settings ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$TEST_TMPDIR/gc-store"
  export HOME="$TEST_TMPDIR/home"
  mkdir -p "$HOME/.claude"

  # Write a marker settings.json
  echo '{"test":"marker"}' > "$HOME/.claude/settings.json"

  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1

  # Verify settings.json unchanged
  content=$(cat "$HOME/.claude/settings.json")
  assert_contains "settings.json not modified" "$content" "marker"

  rm -rf "$TEST_TMPDIR"
)

# ===================================================================
echo ""
echo "=== Test Group 5: --dry-run makes no changes ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$TEST_TMPDIR/gc-store"
  export HOME="$TEST_TMPDIR/home"
  mkdir -p "$HOME"

  output=$(bash "$GC_INSTALL" --dry-run 2>&1)

  # Store should not exist (dry run should not create anything permanent)
  # Note: dry run may create the base dir with mkdir -p before deploying
  # Let's check that no bin files are deployed
  if [ -f "$TEST_TMPDIR/gc-store/bin/gc-init" ]; then
    echo "  FAIL: gc-init should not exist after dry run"
    _record_fail
  else
    echo "  PASS: no bin scripts after dry run"
    _record_pass
  fi

  assert_contains "dry run output mentions dry run" "$output" "Dry run"

  rm -rf "$TEST_TMPDIR"
)

# ===================================================================
echo ""
echo "=== Test Group 6: config.json preserved on reinstall ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$TEST_TMPDIR/gc-store"
  export HOME="$TEST_TMPDIR/home"
  mkdir -p "$HOME"

  # First install
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1

  # Add a custom field to config.json
  tmpjson=$(jq '. + {"custom_field": "preserved"}' "$TEST_TMPDIR/gc-store/config.json")
  echo "$tmpjson" > "$TEST_TMPDIR/gc-store/config.json"

  # Force reinstall
  bash "$GC_INSTALL" --skip-hooks --force >/dev/null 2>&1

  # Verify custom field preserved
  custom=$(jq -r '.custom_field' "$TEST_TMPDIR/gc-store/config.json")
  assert_eq "custom field preserved across reinstall" "preserved" "$custom"

  rm -rf "$TEST_TMPDIR"
)

# ===================================================================
echo ""
echo "=== Test Group 7: CLAUDE_CONTEXT_PATH override works ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$TEST_TMPDIR/custom-path"
  export HOME="$TEST_TMPDIR/home"
  mkdir -p "$HOME"

  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1

  assert_dir_exists "custom path used" "$TEST_TMPDIR/custom-path"
  assert_file_exists "VERSION at custom path" "$TEST_TMPDIR/custom-path/VERSION"

  rm -rf "$TEST_TMPDIR"
)

# ===================================================================
echo ""
echo "=== Test Group 8: Downgrade blocked without --force ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$TEST_TMPDIR/gc-store"
  export HOME="$TEST_TMPDIR/home"
  mkdir -p "$HOME"

  # Install first
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1

  # Bump installed version to simulate newer
  echo "99.0.0" > "$TEST_TMPDIR/gc-store/VERSION"

  # Try to install (should warn about downgrade)
  output=$(bash "$GC_INSTALL" --skip-hooks 2>&1)
  assert_contains "downgrade warning shown" "$output" "newer than available"

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
