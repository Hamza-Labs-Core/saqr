#!/usr/bin/env bash
set -euo pipefail

# 02-integration-tests.sh -- Integration tests for gc-install-hooks lifecycle
# All tests use isolated temp directories to avoid touching the real user environment.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GC_HOOK="$PROJECT_ROOT/src/gc-hook"
GC_INSTALL_HOOKS="$PROJECT_ROOT/src/gc-install-hooks"

# Track pass/fail
RESULT_FILE=$(mktemp)
echo "0 0" > "$RESULT_FILE"
trap 'rm -f "$RESULT_FILE"' EXIT

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

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
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

# Helper to set up a complete isolated environment
setup_env() {
  local tmpdir
  tmpdir=$(mktemp -d)
  local gc_base="$tmpdir/gc-store"
  mkdir -p "$gc_base/bin"
  cp "$GC_HOOK" "$gc_base/bin/gc-hook"
  chmod +x "$gc_base/bin/gc-hook"
  # Create mock capture-event
  cat > "$gc_base/bin/capture-event" <<'SCRIPT'
#!/usr/bin/env bash
cat > /dev/null
SCRIPT
  chmod +x "$gc_base/bin/capture-event"
  echo "$tmpdir"
}

# Run gc-install-hooks in isolated env
run_install() {
  local tmpdir="$1"
  shift
  HOME="$tmpdir/home" CLAUDE_CONTEXT_PATH="$tmpdir/gc-store" bash "$GC_INSTALL_HOOKS" "$@"
}

# ===================================================================
echo "=== T-7: Fresh install on empty settings ==="
# ===================================================================
(
  tmpdir=$(setup_env)
  run_install "$tmpdir" install
  hook_count=$(jq '.hooks | keys | length' "$tmpdir/home/.claude/settings.json")
  assert_eq "10 hooks installed" "10" "$hook_count"
  rm -rf "$tmpdir"
)

# ===================================================================
echo ""
echo "=== T-8: Install preserves existing user hooks ==="
# ===================================================================
(
  tmpdir=$(setup_env)
  mkdir -p "$tmpdir/home/.claude"
  # Create settings with user hook (nested format)
  cat > "$tmpdir/home/.claude/settings.json" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "/usr/local/bin/my-custom-hook",
            "timeout": 3000
          }
        ]
      }
    ]
  }
}
JSON
  run_install "$tmpdir" install
  # Check user hook still exists (search nested .hooks[].command)
  user_hook_count=$(jq '[.hooks.PreToolUse[] | select(
    if .hooks then ([.hooks[] | select((.command // "") | contains("my-custom-hook"))] | length) > 0
    else ((.command // "") | contains("my-custom-hook"))
    end
  )] | length' "$tmpdir/home/.claude/settings.json")
  gc_hook_count=$(jq '[.hooks.PreToolUse[] | select(
    if .hooks then ([.hooks[] | select((.command // "") | contains("gc-hook"))] | length) > 0
    else ((.command // "") | contains("gc-hook"))
    end
  )] | length' "$tmpdir/home/.claude/settings.json")
  assert_eq "user hook preserved" "1" "$user_hook_count"
  assert_eq "gc hook added alongside user hook" "1" "$gc_hook_count"
  rm -rf "$tmpdir"
)

# ===================================================================
echo ""
echo "=== T-9: Install preserves non-hook settings ==="
# ===================================================================
(
  tmpdir=$(setup_env)
  mkdir -p "$tmpdir/home/.claude"
  cat > "$tmpdir/home/.claude/settings.json" <<'JSON'
{
  "model": "opus",
  "theme": "dark"
}
JSON
  run_install "$tmpdir" install
  model=$(jq -r '.model' "$tmpdir/home/.claude/settings.json")
  theme=$(jq -r '.theme' "$tmpdir/home/.claude/settings.json")
  assert_eq "model setting preserved" "opus" "$model"
  assert_eq "theme setting preserved" "dark" "$theme"
  rm -rf "$tmpdir"
)

# ===================================================================
echo ""
echo "=== T-10: Idempotent reinstall ==="
# ===================================================================
(
  tmpdir=$(setup_env)
  run_install "$tmpdir" install
  run_install "$tmpdir" install
  # Check no duplicate gc-hook entries in any event
  for hook_name in SessionStart UserPromptSubmit PreToolUse PostToolUse PostToolUseFailure SubagentStart SubagentStop Stop PreCompact SessionEnd; do
    gc_count=$(jq --arg h "$hook_name" '[.hooks[$h][] | select(
      if .hooks then ([.hooks[] | select((.command // "") | contains("gc-hook"))] | length) > 0
      else ((.command // "") | contains("gc-hook"))
      end
    )] | length' "$tmpdir/home/.claude/settings.json")
    assert_eq "no duplicate for $hook_name" "1" "$gc_count"
  done
  rm -rf "$tmpdir"
)

# ===================================================================
echo ""
echo "=== T-11: Uninstall removes only GC hooks ==="
# ===================================================================
(
  tmpdir=$(setup_env)
  mkdir -p "$tmpdir/home/.claude"
  cat > "$tmpdir/home/.claude/settings.json" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "/usr/local/bin/my-custom-hook",
            "timeout": 3000
          }
        ]
      }
    ]
  }
}
JSON
  run_install "$tmpdir" install
  run_install "$tmpdir" uninstall
  user_hook_count=$(jq '[.hooks.PreToolUse[] | select(
    if .hooks then ([.hooks[] | select((.command // "") | contains("my-custom-hook"))] | length) > 0
    else ((.command // "") | contains("my-custom-hook"))
    end
  )] | length' "$tmpdir/home/.claude/settings.json")
  gc_hook_present=$(jq '[.hooks // {} | to_entries[] | .value[] | select(
    if .hooks then ([.hooks[] | select((.command // "") | contains("gc-hook"))] | length) > 0
    else ((.command // "") | contains("gc-hook"))
    end
  )] | length' "$tmpdir/home/.claude/settings.json")
  assert_eq "user hook survived uninstall" "1" "$user_hook_count"
  assert_eq "all gc hooks removed" "0" "$gc_hook_present"
  rm -rf "$tmpdir"
)

# ===================================================================
echo ""
echo "=== T-12: Uninstall cleans empty structures ==="
# ===================================================================
(
  tmpdir=$(setup_env)
  run_install "$tmpdir" install
  run_install "$tmpdir" uninstall
  has_hooks=$(jq 'has("hooks")' "$tmpdir/home/.claude/settings.json")
  assert_eq "hooks key removed when empty" "false" "$has_hooks"
  rm -rf "$tmpdir"
)

# ===================================================================
echo ""
echo "=== T-13: Backup created on install ==="
# ===================================================================
(
  tmpdir=$(setup_env)
  mkdir -p "$tmpdir/home/.claude"
  echo '{}' > "$tmpdir/home/.claude/settings.json"
  run_install "$tmpdir" install
  backup_count=$(ls "$tmpdir/home/.claude/settings.json.bak."* 2>/dev/null | wc -l)
  if [ "$backup_count" -ge 1 ]; then
    echo "  PASS: backup file exists"
    _record_pass
  else
    echo "  FAIL: no backup file found"
    _record_fail
  fi
  rm -rf "$tmpdir"
)

# ===================================================================
echo ""
echo "=== T-14: Creates ~/.claude/ if missing ==="
# ===================================================================
(
  tmpdir=$(setup_env)
  # Ensure no .claude directory
  rm -rf "$tmpdir/home/.claude"
  run_install "$tmpdir" install
  if [ -d "$tmpdir/home/.claude" ]; then
    echo "  PASS: ~/.claude/ created"
    _record_pass
  else
    echo "  FAIL: ~/.claude/ not created"
    _record_fail
  fi
  # Check permissions
  perms=$(stat -c '%a' "$tmpdir/home/.claude" 2>/dev/null || stat -f '%Lp' "$tmpdir/home/.claude" 2>/dev/null)
  assert_eq "~/.claude/ mode is 700" "700" "$perms"
  rm -rf "$tmpdir"
)

# ===================================================================
echo ""
echo "=== T-15: Aborts on malformed JSON ==="
# ===================================================================
(
  tmpdir=$(setup_env)
  mkdir -p "$tmpdir/home/.claude"
  echo 'not valid json{{{' > "$tmpdir/home/.claude/settings.json"
  exit_code=0
  run_install "$tmpdir" install 2>/dev/null || exit_code=$?
  if [ "$exit_code" -ne 0 ]; then
    echo "  PASS: aborted on malformed JSON"
    _record_pass
  else
    echo "  FAIL: should have aborted on malformed JSON"
    _record_fail
  fi
  rm -rf "$tmpdir"
)

# ===================================================================
echo ""
echo "=== T-16: Aborts if capture-event missing ==="
# ===================================================================
(
  tmpdir=$(setup_env)
  rm -f "$tmpdir/gc-store/bin/capture-event"
  exit_code=0
  run_install "$tmpdir" install 2>/dev/null || exit_code=$?
  if [ "$exit_code" -ne 0 ]; then
    echo "  PASS: aborted when capture-event missing"
    _record_pass
  else
    echo "  FAIL: should have aborted when capture-event missing"
    _record_fail
  fi
  rm -rf "$tmpdir"
)

# ===================================================================
echo ""
echo "=== T-17: Aborts if jq is missing ==="
# ===================================================================
(
  tmpdir=$(setup_env)
  # Create a minimal PATH that excludes jq
  restricted_path="$tmpdir/restricted-bin"
  mkdir -p "$restricted_path"
  # Symlink just bash so the script can run
  ln -s "$(command -v bash)" "$restricted_path/bash"
  ln -s "$(command -v env)" "$restricted_path/env" 2>/dev/null || true
  # Copy essential utilities the script needs (but NOT jq)
  for cmd in mkdir cp cat date stat chmod; do
    local_cmd=$(command -v "$cmd" 2>/dev/null || true)
    if [ -n "$local_cmd" ]; then
      ln -s "$local_cmd" "$restricted_path/$cmd" 2>/dev/null || true
    fi
  done
  exit_code=0
  PATH="$restricted_path" HOME="$tmpdir/home" CLAUDE_CONTEXT_PATH="$tmpdir/gc-store" bash "$GC_INSTALL_HOOKS" install 2>/dev/null || exit_code=$?
  if [ "$exit_code" -ne 0 ]; then
    echo "  PASS: aborted when jq is missing"
    _record_pass
  else
    echo "  FAIL: should have aborted when jq is missing"
    _record_fail
  fi
  rm -rf "$tmpdir"
)

# ===================================================================
echo ""
echo "=== T-18: Validate detects missing hooks ==="
# ===================================================================
(
  tmpdir=$(setup_env)
  run_install "$tmpdir" install
  # Remove one hook
  HOME="$tmpdir/home" jq 'del(.hooks.PreToolUse)' "$tmpdir/home/.claude/settings.json" > "$tmpdir/home/.claude/settings.json.tmp"
  mv "$tmpdir/home/.claude/settings.json.tmp" "$tmpdir/home/.claude/settings.json"
  exit_code=0
  validate_output=$(run_install "$tmpdir" validate 2>&1) || exit_code=$?
  if [ "$exit_code" -ne 0 ]; then
    echo "  PASS: validate detected missing hook"
    _record_pass
  else
    echo "  FAIL: validate should have detected missing PreToolUse"
    _record_fail
  fi
  assert_contains "reports PreToolUse missing" "$validate_output" "PreToolUse"
  rm -rf "$tmpdir"
)

# ===================================================================
echo ""
echo "=== T-19: Validate smoke test succeeds ==="
# ===================================================================
(
  tmpdir=$(setup_env)
  run_install "$tmpdir" install
  exit_code=0
  validate_output=$(run_install "$tmpdir" validate 2>&1) || exit_code=$?
  assert_eq "validate passes after clean install" "0" "$exit_code"
  assert_contains "overall pass reported" "$validate_output" "PASS"
  rm -rf "$tmpdir"
)

# ===================================================================
echo ""
echo "=== T-20: Upgrade from older config ==="
# ===================================================================
(
  tmpdir=$(setup_env)
  run_install "$tmpdir" install
  # Modify timeout of existing GC hook's inner handler to 3000
  HOME="$tmpdir/home" jq '.hooks.PreToolUse[0].hooks[0].timeout = 3000' "$tmpdir/home/.claude/settings.json" > "$tmpdir/home/.claude/settings.json.tmp"
  mv "$tmpdir/home/.claude/settings.json.tmp" "$tmpdir/home/.claude/settings.json"
  # Reinstall
  run_install "$tmpdir" install
  # Check timeout in nested format: matcher_group.hooks[0].timeout
  actual_timeout=$(jq '[.hooks.PreToolUse[] | select(
    if .hooks then ([.hooks[] | select((.command // "") | contains("gc-hook"))] | length) > 0
    else ((.command // "") | contains("gc-hook"))
    end
  )][0] | if .hooks then .hooks[0].timeout else .timeout end' "$tmpdir/home/.claude/settings.json")
  assert_eq "timeout updated to 5000" "5000" "$actual_timeout"
  rm -rf "$tmpdir"
)

# ===================================================================
echo ""
echo "=== T-21: CLAUDE_CONTEXT_PATH override ==="
# ===================================================================
(
  tmpdir=$(setup_env)
  run_install "$tmpdir" install
  # Verify settings.json has correct hook paths
  first_cmd=$(jq -r '.hooks.SessionStart[0] | if .hooks then .hooks[0].command else .command end' "$tmpdir/home/.claude/settings.json")
  assert_contains "hook command uses canonical path" "$first_cmd" "gc-hook"
  rm -rf "$tmpdir"
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
