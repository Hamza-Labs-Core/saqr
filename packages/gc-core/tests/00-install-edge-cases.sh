#!/usr/bin/env bash
set -euo pipefail

# 00-install-edge-cases.sh -- Edge cases and error handling tests

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GC_INSTALL="$PROJECT_ROOT/src/bin/gc-install"
GC_DOCTOR="$PROJECT_ROOT/src/bin/gc-doctor"
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

assert_dir_exists() {
  local label="$1" path="$2"
  if [ -d "$path" ]; then echo "  PASS: $label"; _record_pass
  else echo "  FAIL: $label ($path not found)"; _record_fail; fi
}

assert_file_exists() {
  local label="$1" path="$2"
  if [ -f "$path" ]; then echo "  PASS: $label"; _record_pass
  else echo "  FAIL: $label ($path not found)"; _record_fail; fi
}

# Helper: create mock bin excluding a tool
_create_mock_bin_without() {
  local exclude="$1"
  local mock_dir; mock_dir=$(mktemp -d)
  local all_tools=(jq node sha256sum shasum git flock uuidgen)
  local sys_tools=(bash env cat cut awk sed tr date dirname basename find stat wc ls mv rm cp mkdir chmod touch head tail grep sort uniq tee mktemp df readlink id du rmdir printf)

  for tool in "${all_tools[@]}"; do
    [[ "$tool" == "$exclude" ]] && continue
    local tool_path; tool_path=$(command -v "$tool" 2>/dev/null || true)
    [[ -n "$tool_path" ]] && ln -sf "$tool_path" "$mock_dir/$tool"
  done
  for tool in "${sys_tools[@]}"; do
    local tool_path; tool_path=$(command -v "$tool" 2>/dev/null || true)
    [[ -n "$tool_path" ]] && ln -sf "$tool_path" "$mock_dir/$tool"
  done
  echo "$mock_dir"
}

_do_install() {
  local t="$1"
  export CLAUDE_CONTEXT_PATH="$t/store" HOME="$t/home"
  mkdir -p "$HOME/.claude"
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1
}

echo "=== Edge Case Integration Tests ==="
echo ""

# --- Test 34: Install aborts if jq missing ---
(
  echo "--- Test 34: Install aborts if jq missing ---"
  T=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$T/store" HOME="$T/home"
  mkdir -p "$HOME"
  MOCK_BIN=$(_create_mock_bin_without jq)
  export PATH="$MOCK_BIN"
  exit_code=0
  output=$(bash "$GC_INSTALL" --skip-hooks 2>&1) || exit_code=$?
  assert_eq "install aborts with jq missing" "1" "$exit_code"
  assert_contains "error mentions prerequisites" "$output" "prerequisites"
  rm -rf "$T" "$MOCK_BIN"
)

# --- Test 35: Install aborts if node missing ---
(
  echo "--- Test 35: Install aborts if node missing ---"
  T=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$T/store" HOME="$T/home"
  mkdir -p "$HOME"
  MOCK_BIN=$(_create_mock_bin_without node)
  export PATH="$MOCK_BIN"
  exit_code=0
  output=$(bash "$GC_INSTALL" --skip-hooks 2>&1) || exit_code=$?
  assert_eq "install aborts with node missing" "1" "$exit_code"
  rm -rf "$T" "$MOCK_BIN"
)

# --- Test 37: Install with --skip-hooks skips hook registration ---
(
  echo "--- Test 37: --skip-hooks skips registration ---"
  T=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$T/store" HOME="$T/home"
  mkdir -p "$HOME/.claude"
  echo '{"test":"marker"}' > "$HOME/.claude/settings.json"
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1
  content=$(cat "$HOME/.claude/settings.json")
  assert_contains "settings.json unchanged" "$content" "marker"
  rm -rf "$T"
)

# --- Test 38: Install with --dry-run makes no changes ---
(
  echo "--- Test 38: --dry-run makes no changes ---"
  T=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$T/store" HOME="$T/home"
  mkdir -p "$HOME"
  output=$(bash "$GC_INSTALL" --dry-run 2>&1)
  if [ -f "$T/store/bin/gc-init" ]; then
    echo "  FAIL: gc-init should not exist after dry run"; _record_fail
  else
    echo "  PASS: no files deployed in dry run"; _record_pass
  fi
  rm -rf "$T"
)

# --- Test 39: Doctor detects missing prerequisites ---
(
  echo "--- Test 39: Doctor detects missing prerequisites ---"
  T=$(mktemp -d)
  _do_install "$T"
  MOCK_BIN=$(_create_mock_bin_without node)
  export PATH="$MOCK_BIN"
  exit_code=0
  output=$(bash "$GC_DOCTOR" 2>&1) || exit_code=$?
  assert_eq "doctor fails with node missing" "1" "$exit_code"
  assert_contains "doctor reports failure" "$output" "FAIL"
  rm -rf "$T" "$MOCK_BIN"
)

# --- Test 41: Doctor handles uninitialized system ---
(
  echo "--- Test 41: Doctor handles uninitialized system ---"
  T=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$T/nonexistent" HOME="$T/home"
  mkdir -p "$HOME"
  exit_code=0
  output=$(bash "$GC_DOCTOR" 2>&1) || exit_code=$?
  assert_eq "doctor fails on uninitialized" "1" "$exit_code"
  assert_contains "detects missing store" "$output" "FAIL"
  rm -rf "$T"
)

# --- Test 42: Uninstall on non-installed system exits 0 ---
(
  echo "--- Test 42: Uninstall on non-installed exits 0 ---"
  T=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$T/nonexistent" HOME="$T/home"
  mkdir -p "$HOME"
  exit_code=0
  output=$(bash "$GC_UNINSTALL" 2>&1) || exit_code=$?
  assert_eq "exits 0" "0" "$exit_code"
  assert_contains "not installed message" "$output" "not installed"
  rm -rf "$T"
)

# --- Test 43: Double install is idempotent ---
(
  echo "--- Test 43: Double install is idempotent ---"
  T=$(mktemp -d)
  _do_install "$T"
  output=$(bash "$GC_INSTALL" --skip-hooks 2>&1)
  assert_contains "second install detects same version" "$output" "Already up to date"
  # Force second install and verify store is intact
  bash "$GC_INSTALL" --skip-hooks --force >/dev/null 2>&1
  assert_dir_exists "store still valid after double install" "$T/store"
  assert_file_exists "config.json still exists" "$T/store/config.json"
  rm -rf "$T"
)

echo ""
counts=$(cat "$RESULT_FILE")
PASS=$(echo "$counts" | cut -d' ' -f1)
FAIL=$(echo "$counts" | cut -d' ' -f2)
echo "=============================="
echo "Edge Cases: $PASS passed, $FAIL failed"
echo "=============================="
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
