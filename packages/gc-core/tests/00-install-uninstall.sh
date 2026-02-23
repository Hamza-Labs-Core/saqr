#!/usr/bin/env bash
set -euo pipefail

# 00-install-uninstall.sh -- Integration tests for uninstall scenarios

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GC_INSTALL="$PROJECT_ROOT/src/bin/gc-install"
GC_UNINSTALL="$PROJECT_ROOT/src/bin/gc-uninstall"

RESULT_FILE=$(mktemp)
echo "0 0" > "$RESULT_FILE"

cleanup() { rm -f "$RESULT_FILE"; }
trap cleanup EXIT

_record_pass() {
  local counts; counts=$(cat "$RESULT_FILE")
  local p f; p=$(echo "$counts" | cut -d' ' -f1); f=$(echo "$counts" | cut -d' ' -f2)
  echo "$((p + 1)) $f" > "$RESULT_FILE"
}

_record_fail() {
  local counts; counts=$(cat "$RESULT_FILE")
  local p f; p=$(echo "$counts" | cut -d' ' -f1); f=$(echo "$counts" | cut -d' ' -f2)
  echo "$p $((f + 1))" > "$RESULT_FILE"
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then echo "  PASS: $label"; _record_pass
  else echo "  FAIL: $label"; echo "    expected: $expected"; echo "    actual:   $actual"; _record_fail; fi
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -qF "$needle"; then echo "  PASS: $label"; _record_pass
  else echo "  FAIL: $label"; echo "    expected to contain: $needle"; _record_fail; fi
}

assert_file_exists() {
  local label="$1" path="$2"
  if [ -f "$path" ]; then echo "  PASS: $label"; _record_pass
  else echo "  FAIL: $label ($path not found)"; _record_fail; fi
}

assert_dir_exists() {
  local label="$1" path="$2"
  if [ -d "$path" ]; then echo "  PASS: $label"; _record_pass
  else echo "  FAIL: $label ($path not found)"; _record_fail; fi
}

assert_dir_not_exists() {
  local label="$1" path="$2"
  if [ ! -d "$path" ]; then echo "  PASS: $label"; _record_pass
  else echo "  FAIL: $label ($path still exists)"; _record_fail; fi
}

_do_install() {
  local t="$1"
  export CLAUDE_CONTEXT_PATH="$t/store" HOME="$t/home"
  mkdir -p "$HOME/.claude"
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1
}

echo "=== Uninstall Integration Tests ==="
echo ""

# --- Test 23: Soft uninstall removes hooks ---
(
  echo "--- Test 23: Soft uninstall removes hooks ---"
  T=$(mktemp -d)
  _do_install "$T"
  output=$(bash "$GC_UNINSTALL" 2>&1)
  assert_contains "hooks removal attempted" "$output" "hooks"
  rm -rf "$T"
)

# --- Test 24: Soft uninstall removes bin/ and lib/ ---
(
  echo "--- Test 24: Soft uninstall removes bin/ and lib/ ---"
  T=$(mktemp -d)
  _do_install "$T"
  bash "$GC_UNINSTALL" >/dev/null 2>&1
  assert_dir_not_exists "bin/ removed" "$T/store/bin"
  assert_dir_not_exists "lib/ removed" "$T/store/lib"
  rm -rf "$T"
)

# --- Test 25: Soft uninstall preserves events/ ---
(
  echo "--- Test 25: Soft uninstall preserves events/ ---"
  T=$(mktemp -d)
  _do_install "$T"
  mkdir -p "$T/store/events/proj-abc123/sess-001"
  echo '{"data":true}' > "$T/store/events/proj-abc123/sess-001/000001.json"
  bash "$GC_UNINSTALL" >/dev/null 2>&1
  assert_dir_exists "events/ preserved" "$T/store/events"
  assert_file_exists "event data preserved" "$T/store/events/proj-abc123/sess-001/000001.json"
  rm -rf "$T"
)

# --- Test 26: Soft uninstall preserves config.json ---
(
  echo "--- Test 26: Soft uninstall preserves config.json ---"
  T=$(mktemp -d)
  _do_install "$T"
  bash "$GC_UNINSTALL" >/dev/null 2>&1
  assert_file_exists "config.json preserved" "$T/store/config.json"
  rm -rf "$T"
)

# --- Test 27: Purge uninstall removes everything ---
(
  echo "--- Test 27: Purge removes everything ---"
  T=$(mktemp -d)
  _do_install "$T"
  mkdir -p "$T/store/events/proj-abc123/sess-001"
  echo '{"data":true}' > "$T/store/events/proj-abc123/sess-001/000001.json"
  bash "$GC_UNINSTALL" --purge --force >/dev/null 2>&1
  assert_dir_not_exists "store root removed" "$T/store"
  rm -rf "$T"
)

# --- Test 28: Purge requires confirmation ---
(
  echo "--- Test 28: Purge requires confirmation ---"
  T=$(mktemp -d)
  _do_install "$T"
  output=$(echo "no" | bash "$GC_UNINSTALL" --purge 2>&1) || true
  assert_dir_exists "store preserved on decline" "$T/store"
  assert_contains "aborted message" "$output" "Aborted"
  rm -rf "$T"
)

# --- Test 29: Purge --force skips confirmation ---
(
  echo "--- Test 29: Purge --force skips confirmation ---"
  T=$(mktemp -d)
  _do_install "$T"
  bash "$GC_UNINSTALL" --purge --force >/dev/null 2>&1
  assert_dir_not_exists "store removed with --force" "$T/store"
  rm -rf "$T"
)

# --- Test 30: Dry run makes no changes ---
(
  echo "--- Test 30: Dry run makes no changes ---"
  T=$(mktemp -d)
  _do_install "$T"
  output=$(bash "$GC_UNINSTALL" --dry-run 2>&1)
  assert_dir_exists "bin/ still exists after dry run" "$T/store/bin"
  assert_dir_exists "lib/ still exists after dry run" "$T/store/lib"
  assert_contains "dry run message" "$output" "Dry run"
  rm -rf "$T"
)

# --- Test 32: Reinstall after soft uninstall preserves data ---
(
  echo "--- Test 32: Reinstall after soft uninstall preserves data ---"
  T=$(mktemp -d)
  _do_install "$T"
  mkdir -p "$T/store/events/proj-abc123/sess-001"
  echo '{"data":"keep"}' > "$T/store/events/proj-abc123/sess-001/000001.json"
  bash "$GC_UNINSTALL" >/dev/null 2>&1
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1
  assert_file_exists "event data after reinstall" "$T/store/events/proj-abc123/sess-001/000001.json"
  content=$(cat "$T/store/events/proj-abc123/sess-001/000001.json")
  assert_contains "event content after reinstall" "$content" "keep"
  rm -rf "$T"
)

# --- Test 33: Reinstall after purge is fresh install ---
(
  echo "--- Test 33: Reinstall after purge is fresh install ---"
  T=$(mktemp -d)
  _do_install "$T"
  bash "$GC_UNINSTALL" --purge --force >/dev/null 2>&1
  output=$(bash "$GC_INSTALL" --skip-hooks 2>&1)
  assert_dir_exists "fresh install after purge" "$T/store"
  assert_contains "fresh install message" "$output" "Installation complete!"
  rm -rf "$T"
)

echo ""
counts=$(cat "$RESULT_FILE")
PASS=$(echo "$counts" | cut -d' ' -f1)
FAIL=$(echo "$counts" | cut -d' ' -f2)
echo "=============================="
echo "Uninstall: $PASS passed, $FAIL failed"
echo "=============================="
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
