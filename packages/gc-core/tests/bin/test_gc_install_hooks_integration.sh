#!/usr/bin/env bash
set -euo pipefail

# test_gc_install_hooks_integration.sh -- Hook registration integration tests
# Tests the hook registration flow from gc-install, including edge cases
# around ~/.claude/settings.json handling.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GC_INSTALL="$PROJECT_ROOT/src/bin/gc-install"

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

# ===================================================================
echo "=== Test Group 1: --skip-hooks leaves settings.json untouched ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$TEST_TMPDIR/gc-store"
  export HOME="$TEST_TMPDIR/home"
  mkdir -p "$HOME/.claude"
  echo '{"user_setting":"value"}' > "$HOME/.claude/settings.json"

  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1

  content=$(cat "$HOME/.claude/settings.json")
  assert_contains "settings.json preserved with --skip-hooks" "$content" "user_setting"

  rm -rf "$TEST_TMPDIR"
)

# ===================================================================
echo ""
echo "=== Test Group 2: Install without gc-install-hooks skips gracefully ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$TEST_TMPDIR/gc-store"
  export HOME="$TEST_TMPDIR/home"
  mkdir -p "$HOME"

  # Run install -- gc-install-hooks doesn't exist yet (Story 02)
  # but the installer should handle this gracefully
  output=$(bash "$GC_INSTALL" --skip-hooks 2>&1)
  assert_contains "install completes without hooks" "$output" "Installation complete!"

  rm -rf "$TEST_TMPDIR"
)

# ===================================================================
echo ""
echo "=== Test Group 3: Hook registration creates .claude dir ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$TEST_TMPDIR/gc-store"
  export HOME="$TEST_TMPDIR/home"
  # Note: not creating $HOME/.claude -- gc-install should create it

  # First install with --skip-hooks to get files deployed, then we test the
  # hook registration path. Since gc-install-hooks is a Story 02 dependency,
  # we create a minimal stub that gc-install can call.
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1

  # Create a stub gc-install-hooks
  cat > "$TEST_TMPDIR/gc-store/bin/gc-install-hooks" << 'HOOKSCRIPT'
#!/usr/bin/env bash
set -euo pipefail
# Stub gc-install-hooks for testing
case "${1:-}" in
  install)
    local_claude_dir="${HOME}/.claude"
    mkdir -p "$local_claude_dir"
    if [ ! -f "$local_claude_dir/settings.json" ]; then
      echo '{"hooks":{}}' > "$local_claude_dir/settings.json"
    fi
    exit 0
    ;;
  uninstall)
    exit 0
    ;;
  *)
    echo "Usage: gc-install-hooks install|uninstall" >&2
    exit 1
    ;;
esac
HOOKSCRIPT
  chmod +x "$TEST_TMPDIR/gc-store/bin/gc-install-hooks"

  # Force reinstall (without --skip-hooks this time)
  output=$(bash "$GC_INSTALL" --force 2>&1)

  assert_dir_exists ".claude dir created" "$HOME/.claude"
  assert_contains "hooks registered message" "$output" "Hooks registered"

  rm -rf "$TEST_TMPDIR"
)

# ===================================================================
echo ""
echo "=== Test Group 4: Consecutive installs are idempotent ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$TEST_TMPDIR/gc-store"
  export HOME="$TEST_TMPDIR/home"
  mkdir -p "$HOME/.claude"
  echo '{"hooks":{}}' > "$HOME/.claude/settings.json"

  # Install twice with --skip-hooks
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1
  output2=$(bash "$GC_INSTALL" --skip-hooks 2>&1)

  # Second run should detect same version
  assert_contains "second install detects same version" "$output2" "Already up to date"

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
