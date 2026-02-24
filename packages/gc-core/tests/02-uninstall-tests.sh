#!/usr/bin/env bash
set -euo pipefail

# 02-uninstall-tests.sh -- Tests for gc-uninstall command
# All tests use isolated temp directories.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GC_UNINSTALL="$PROJECT_ROOT/src/bin/gc-uninstall"
GC_INSTALL_HOOKS="$PROJECT_ROOT/src/gc-install-hooks"
GC_HOOK="$PROJECT_ROOT/src/gc-hook"

# Track pass/fail
RESULT_FILE=$(mktemp)
echo "0 0" > "$RESULT_FILE"
TMPDIR_BASE=$(mktemp -d)
trap 'rm -f "$RESULT_FILE"; rm -rf "$TMPDIR_BASE"' EXIT

_record_pass() {
  local counts p f
  counts=$(cat "$RESULT_FILE")
  p=$(echo "$counts" | cut -d' ' -f1)
  f=$(echo "$counts" | cut -d' ' -f2)
  echo "$((p + 1)) $f" > "$RESULT_FILE"
}

_record_fail() {
  local counts p f
  counts=$(cat "$RESULT_FILE")
  p=$(echo "$counts" | cut -d' ' -f1)
  f=$(echo "$counts" | cut -d' ' -f2)
  echo "$p $((f + 1))" > "$RESULT_FILE"
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
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

# Helper: set up a fully installed environment
setup_installed_env() {
  local tmpdir
  tmpdir=$(mktemp -d "$TMPDIR_BASE/env-XXXXXX")
  local gc_base="$tmpdir/gc-store"
  mkdir -p "$gc_base/bin" "$gc_base/lib" "$gc_base/events/proj-abc123/session-001"
  cp "$GC_HOOK" "$gc_base/bin/gc-hook"
  chmod +x "$gc_base/bin/gc-hook"
  cp "$GC_INSTALL_HOOKS" "$gc_base/bin/gc-install-hooks"
  chmod +x "$gc_base/bin/gc-install-hooks"
  # Create mock capture-event
  printf '#!/usr/bin/env bash\ncat > /dev/null\n' > "$gc_base/bin/capture-event"
  chmod +x "$gc_base/bin/capture-event"
  # Create some fake event files
  echo '{"type":"SessionStarted"}' > "$gc_base/events/proj-abc123/session-001/0001.json"
  # Install hooks
  HOME="$tmpdir/home" CLAUDE_CONTEXT_PATH="$gc_base" bash "$GC_INSTALL_HOOKS" install >/dev/null 2>&1
  echo "$tmpdir"
}

# ===================================================================
echo "=== T-1: Full uninstall with --force ==="
# ===================================================================
(
  tmpdir=$(setup_installed_env)
  HOME="$tmpdir/home" CLAUDE_CONTEXT_PATH="$tmpdir/gc-store" "$GC_UNINSTALL" --purge --force >/dev/null 2>&1
  # Check hooks removed
  gc_hook_count=$(jq '[.hooks // {} | to_entries[] | .value[] | select(
      if .hooks then ([.hooks[] | select((.command // "") | contains("gc-hook"))] | length) > 0
      else ((.command // "") | contains("gc-hook"))
      end
    )] | length' "$tmpdir/home/.claude/settings.json" 2>/dev/null || echo 0)
  assert_eq "hooks removed from settings.json" "0" "$gc_hook_count"
  # Check store deleted
  if [ ! -d "$tmpdir/gc-store" ]; then
    echo "  PASS: store directory deleted"
    _record_pass
  else
    echo "  FAIL: store directory should be deleted"
    _record_fail
  fi
)

# ===================================================================
echo ""
echo "=== T-2: --keep-data preserves store ==="
# ===================================================================
(
  tmpdir=$(setup_installed_env)
  HOME="$tmpdir/home" CLAUDE_CONTEXT_PATH="$tmpdir/gc-store" "$GC_UNINSTALL" --force --keep-data >/dev/null 2>&1
  # Hooks should be removed
  gc_hook_count=$(jq '[.hooks // {} | to_entries[] | .value[] | select(
      if .hooks then ([.hooks[] | select((.command // "") | contains("gc-hook"))] | length) > 0
      else ((.command // "") | contains("gc-hook"))
      end
    )] | length' "$tmpdir/home/.claude/settings.json" 2>/dev/null || echo 0)
  assert_eq "hooks removed with --keep-data" "0" "$gc_hook_count"
  # Store should still exist
  if [ -d "$tmpdir/gc-store" ]; then
    echo "  PASS: store preserved with --keep-data"
    _record_pass
  else
    echo "  FAIL: store should be preserved with --keep-data"
    _record_fail
  fi
  # Event files should still exist
  if [ -f "$tmpdir/gc-store/events/proj-abc123/session-001/0001.json" ]; then
    echo "  PASS: event data preserved"
    _record_pass
  else
    echo "  FAIL: event data should be preserved"
    _record_fail
  fi
)

# ===================================================================
echo ""
echo "=== T-3: --purge requires confirmation ==="
# ===================================================================
(
  tmpdir=$(setup_installed_env)
  exit_code=0
  # --purge without --force requires confirmation; pipe "no" to decline
  echo "no" | HOME="$tmpdir/home" CLAUDE_CONTEXT_PATH="$tmpdir/gc-store" "$GC_UNINSTALL" --purge 2>&1 >/dev/null || exit_code=$?
  # Should have aborted (exit 1 due to "no" confirmation)
  if [ "$exit_code" -ne 0 ]; then
    echo "  PASS: purge aborted without 'yes'"
    _record_pass
  else
    echo "  FAIL: purge should abort without 'yes' confirmation"
    _record_fail
  fi
  # Store should still exist
  if [ -d "$tmpdir/gc-store" ]; then
    echo "  PASS: store preserved after abort"
    _record_pass
  else
    echo "  FAIL: store should be preserved after abort"
    _record_fail
  fi
)

# ===================================================================
echo ""
echo "=== T-4: --dry-run makes no changes ==="
# ===================================================================
(
  tmpdir=$(setup_installed_env)
  output=$(HOME="$tmpdir/home" CLAUDE_CONTEXT_PATH="$tmpdir/gc-store" "$GC_UNINSTALL" --dry-run 2>&1)
  # Hooks should still be present
  gc_hook_count=$(jq '[.hooks // {} | to_entries[] | .value[] | select(
      if .hooks then ([.hooks[] | select((.command // "") | contains("gc-hook"))] | length) > 0
      else ((.command // "") | contains("gc-hook"))
      end
    )] | length' "$tmpdir/home/.claude/settings.json" 2>/dev/null || echo 0)
  if [ "$gc_hook_count" -gt 0 ]; then
    echo "  PASS: hooks preserved in dry-run"
    _record_pass
  else
    echo "  FAIL: hooks should be preserved in dry-run"
    _record_fail
  fi
  # Store should still exist
  if [ -d "$tmpdir/gc-store" ]; then
    echo "  PASS: store preserved in dry-run"
    _record_pass
  else
    echo "  FAIL: store should be preserved in dry-run"
    _record_fail
  fi
)

# ===================================================================
echo ""
echo "=== T-5: Uninstall when hooks already removed ==="
# ===================================================================
(
  tmpdir=$(setup_installed_env)
  # Manually remove hooks first
  HOME="$tmpdir/home" CLAUDE_CONTEXT_PATH="$tmpdir/gc-store" bash "$GC_INSTALL_HOOKS" uninstall >/dev/null 2>&1
  # Now run gc-uninstall -- should not error
  exit_code=0
  HOME="$tmpdir/home" CLAUDE_CONTEXT_PATH="$tmpdir/gc-store" "$GC_UNINSTALL" --force >/dev/null 2>&1 || exit_code=$?
  assert_eq "no error when hooks already removed" "0" "$exit_code"
)

# ===================================================================
echo ""
echo "=== T-6: Uninstall when store does not exist ==="
# ===================================================================
(
  tmpdir=$(mktemp -d "$TMPDIR_BASE/env-XXXXXX")
  mkdir -p "$tmpdir/home/.claude"
  echo '{}' > "$tmpdir/home/.claude/settings.json"
  exit_code=0
  output=$(HOME="$tmpdir/home" CLAUDE_CONTEXT_PATH="$tmpdir/gc-store-nonexistent" "$GC_UNINSTALL" --force 2>&1) || exit_code=$?
  assert_eq "no error when store does not exist" "0" "$exit_code"
)

# ===================================================================
echo ""
echo "=== T-7: After full uninstall, no GC hooks and no store ==="
# ===================================================================
(
  tmpdir=$(setup_installed_env)
  HOME="$tmpdir/home" CLAUDE_CONTEXT_PATH="$tmpdir/gc-store" "$GC_UNINSTALL" --purge --force >/dev/null 2>&1
  # Verify no GC hooks
  gc_hook_count=$(jq '[.hooks // {} | to_entries[] | .value[] | select(
      if .hooks then ([.hooks[] | select((.command // "") | contains("gc-hook"))] | length) > 0
      else ((.command // "") | contains("gc-hook"))
      end
    )] | length' "$tmpdir/home/.claude/settings.json" 2>/dev/null || echo 0)
  assert_eq "no GC hooks after full uninstall" "0" "$gc_hook_count"
  # Verify no store
  if [ ! -d "$tmpdir/gc-store" ]; then
    echo "  PASS: store deleted after full uninstall"
    _record_pass
  else
    echo "  FAIL: store should be deleted"
    _record_fail
  fi
)

# ===================================================================
echo ""
echo "=== T-8: Reinstall after partial uninstall (--keep-data) ==="
# ===================================================================
(
  tmpdir=$(setup_installed_env)
  # Partial uninstall
  HOME="$tmpdir/home" CLAUDE_CONTEXT_PATH="$tmpdir/gc-store" "$GC_UNINSTALL" --force --keep-data >/dev/null 2>&1
  # Reinstall -- re-deploy bins first, then install hooks
  HOME="$tmpdir/home" CLAUDE_CONTEXT_PATH="$tmpdir/gc-store" bash "$PROJECT_ROOT/src/bin/gc-install" --skip-hooks >/dev/null 2>&1
  HOME="$tmpdir/home" CLAUDE_CONTEXT_PATH="$tmpdir/gc-store" bash "$GC_INSTALL_HOOKS" install >/dev/null 2>&1
  hook_count=$(jq '.hooks | keys | length' "$tmpdir/home/.claude/settings.json")
  assert_eq "reinstall after --keep-data works" "10" "$hook_count"
  # Event data still there
  if [ -f "$tmpdir/gc-store/events/proj-abc123/session-001/0001.json" ]; then
    echo "  PASS: original event data still present"
    _record_pass
  else
    echo "  FAIL: event data should still be present"
    _record_fail
  fi
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
