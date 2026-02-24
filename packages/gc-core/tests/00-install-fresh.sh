#!/usr/bin/env bash
set -euo pipefail

# 00-install-fresh.sh -- Integration tests for fresh GlobalContext installation

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GC_INSTALL="$PROJECT_ROOT/src/bin/gc-install"
GC_DOCTOR="$PROJECT_ROOT/src/bin/gc-doctor"

RESULT_FILE=$(mktemp)
echo "0 0" > "$RESULT_FILE"

cleanup() {
  rm -f "$RESULT_FILE"
}
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

assert_file_exists() {
  local label="$1" path="$2"
  if [ -f "$path" ]; then echo "  PASS: $label"; _record_pass
  else echo "  FAIL: $label (file not found: $path)"; _record_fail; fi
}

assert_dir_exists() {
  local label="$1" path="$2"
  if [ -d "$path" ]; then echo "  PASS: $label"; _record_pass
  else echo "  FAIL: $label (dir not found: $path)"; _record_fail; fi
}

assert_file_mode() {
  local label="$1" path="$2" expected_mode="$3"
  local actual_mode; actual_mode=$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path" 2>/dev/null)
  if [ "$expected_mode" = "$actual_mode" ]; then echo "  PASS: $label"; _record_pass
  else echo "  FAIL: $label (expected $expected_mode, got $actual_mode)"; _record_fail; fi
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -qF "$needle"; then echo "  PASS: $label"; _record_pass
  else echo "  FAIL: $label"; echo "    expected to contain: $needle"; _record_fail; fi
}

echo "=== Fresh Installation Integration Tests ==="
echo ""

# --- Test 1: Fresh install creates all directories ---
(
  echo "--- Test 1: Fresh install creates all directories ---"
  T=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$T/store" HOME="$T/home"
  mkdir -p "$HOME"
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1
  assert_dir_exists "store root" "$T/store"
  assert_dir_exists "events/" "$T/store/events"
  assert_dir_exists "projections/" "$T/store/projections"
  assert_dir_exists "bin/" "$T/store/bin"
  assert_dir_exists "lib/" "$T/store/lib"
  rm -rf "$T"
)

# --- Test 2: Fresh install deploys bin/ scripts with 755 ---
(
  echo "--- Test 2: bin/ scripts have 755 permissions ---"
  T=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$T/store" HOME="$T/home"
  mkdir -p "$HOME"
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1
  for script in "$T/store/bin/"*; do
    [ -f "$script" ] || continue
    name=$(basename "$script")
    assert_file_mode "bin/$name is 755" "$script" "755"
  done
  rm -rf "$T"
)

# --- Test 3: Fresh install deploys lib/ modules with 644 ---
(
  echo "--- Test 3: lib/ modules have 644 permissions ---"
  T=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$T/store" HOME="$T/home"
  mkdir -p "$HOME"
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1
  for module in "$T/store/lib/"*; do
    [ -f "$module" ] || continue
    name=$(basename "$module")
    assert_file_mode "lib/$name is 644" "$module" "644"
  done
  rm -rf "$T"
)

# --- Test 4: Fresh install creates config.json ---
(
  echo "--- Test 4: config.json created with defaults ---"
  T=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$T/store" HOME="$T/home"
  mkdir -p "$HOME"
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1
  assert_file_exists "config.json exists" "$T/store/config.json"
  # Verify valid JSON with required fields
  ver=$(jq -r '.version' "$T/store/config.json" 2>/dev/null)
  assert_eq "config.json has version field" "1.0.0" "$ver"
  rm -rf "$T"
)

# --- Test 5: Fresh install creates VERSION file ---
(
  echo "--- Test 5: VERSION file created ---"
  T=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$T/store" HOME="$T/home"
  mkdir -p "$HOME"
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1
  assert_file_exists "VERSION exists" "$T/store/VERSION"
  ver=$(tr -d '[:space:]' < "$T/store/VERSION")
  assert_eq "VERSION contains 1.0.0" "1.0.0" "$ver"
  rm -rf "$T"
)

# --- Test 8: gc-doctor passes after fresh install ---
(
  echo "--- Test 8: gc-doctor passes after fresh install ---"
  T=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$T/store" HOME="$T/home"
  mkdir -p "$HOME/.claude"
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1
  exit_code=0
  bash "$GC_DOCTOR" >/dev/null 2>&1 || exit_code=$?
  assert_eq "gc-doctor exits 0" "0" "$exit_code"
  rm -rf "$T"
)

# --- Test 10: Store root has permissions 700 ---
(
  echo "--- Test 10: Store root permissions 700 ---"
  T=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$T/store" HOME="$T/home"
  mkdir -p "$HOME"
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1
  assert_file_mode "store root is 700" "$T/store" "700"
  rm -rf "$T"
)

# --- Test 11: CLAUDE_CONTEXT_PATH override works ---
(
  echo "--- Test 11: CLAUDE_CONTEXT_PATH override ---"
  T=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$T/custom-store-path" HOME="$T/home"
  mkdir -p "$HOME"
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1
  assert_dir_exists "custom store path used" "$T/custom-store-path"
  assert_file_exists "VERSION at custom path" "$T/custom-store-path/VERSION"
  rm -rf "$T"
)

echo ""
counts=$(cat "$RESULT_FILE")
PASS=$(echo "$counts" | cut -d' ' -f1)
FAIL=$(echo "$counts" | cut -d' ' -f2)
echo "=============================="
echo "Fresh Install: $PASS passed, $FAIL failed"
echo "=============================="
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
