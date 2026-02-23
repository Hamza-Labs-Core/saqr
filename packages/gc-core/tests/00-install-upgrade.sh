#!/usr/bin/env bash
set -euo pipefail

# 00-install-upgrade.sh -- Integration tests for GlobalContext upgrade scenarios

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GC_INSTALL="$PROJECT_ROOT/src/bin/gc-install"

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

_do_install() {
  local t="$1"
  export CLAUDE_CONTEXT_PATH="$t/store" HOME="$t/home"
  mkdir -p "$HOME"
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1
}

echo "=== Upgrade Integration Tests ==="
echo ""

# --- Test 12: Upgrade detects version mismatch ---
(
  echo "--- Test 12: Upgrade detects version mismatch ---"
  T=$(mktemp -d)
  _do_install "$T"
  # Simulate older installed version
  echo "0.9.0" > "$T/store/VERSION"
  output=$(bash "$GC_INSTALL" --skip-hooks 2>&1)
  assert_contains "detects upgrade" "$output" "Upgrading"
  rm -rf "$T"
)

# --- Test 13: Upgrade overwrites bin/ scripts ---
(
  echo "--- Test 13: Upgrade overwrites bin/ scripts ---"
  T=$(mktemp -d)
  _do_install "$T"
  echo "0.9.0" > "$T/store/VERSION"
  echo "# old content" > "$T/store/bin/gc-init"
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1
  if grep -q "# old content" "$T/store/bin/gc-init"; then
    echo "  FAIL: gc-init was not overwritten"; _record_fail
  else
    echo "  PASS: gc-init was overwritten on upgrade"; _record_pass
  fi
  rm -rf "$T"
)

# --- Test 14: Upgrade overwrites lib/ modules ---
(
  echo "--- Test 14: Upgrade overwrites lib/ modules ---"
  T=$(mktemp -d)
  _do_install "$T"
  echo "0.9.0" > "$T/store/VERSION"
  echo "# old module" > "$T/store/lib/paths.sh"
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1
  if grep -q "# old module" "$T/store/lib/paths.sh"; then
    echo "  FAIL: paths.sh was not overwritten"; _record_fail
  else
    echo "  PASS: paths.sh was overwritten on upgrade"; _record_pass
  fi
  rm -rf "$T"
)

# --- Test 15: Upgrade preserves config.json ---
(
  echo "--- Test 15: Upgrade preserves config.json ---"
  T=$(mktemp -d)
  _do_install "$T"
  # Add custom field
  tmpjson=$(jq '. + {"custom":"preserved"}' "$T/store/config.json")
  echo "$tmpjson" > "$T/store/config.json"
  echo "0.9.0" > "$T/store/VERSION"
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1
  val=$(jq -r '.custom' "$T/store/config.json")
  assert_eq "custom field preserved" "preserved" "$val"
  rm -rf "$T"
)

# --- Test 16: Upgrade preserves event data ---
(
  echo "--- Test 16: Upgrade preserves event data ---"
  T=$(mktemp -d)
  _do_install "$T"
  mkdir -p "$T/store/events/proj-abc123/sess-001"
  echo '{"data":"important"}' > "$T/store/events/proj-abc123/sess-001/000001.json"
  echo "0.9.0" > "$T/store/VERSION"
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1
  assert_file_exists "event data preserved" "$T/store/events/proj-abc123/sess-001/000001.json"
  content=$(cat "$T/store/events/proj-abc123/sess-001/000001.json")
  assert_contains "event content intact" "$content" "important"
  rm -rf "$T"
)

# --- Test 17: Upgrade updates VERSION file ---
(
  echo "--- Test 17: Upgrade updates VERSION file ---"
  T=$(mktemp -d)
  _do_install "$T"
  echo "0.9.0" > "$T/store/VERSION"
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1
  ver=$(tr -d '[:space:]' < "$T/store/VERSION")
  assert_eq "VERSION updated to 1.0.0" "1.0.0" "$ver"
  rm -rf "$T"
)

# --- Test 19: Same version without --force skips upgrade ---
(
  echo "--- Test 19: Same version skips upgrade ---"
  T=$(mktemp -d)
  _do_install "$T"
  output=$(bash "$GC_INSTALL" --skip-hooks 2>&1)
  assert_contains "already up to date" "$output" "Already up to date"
  rm -rf "$T"
)

# --- Test 20: Same version with --force reinstalls ---
(
  echo "--- Test 20: Same version with --force reinstalls ---"
  T=$(mktemp -d)
  _do_install "$T"
  output=$(bash "$GC_INSTALL" --skip-hooks --force 2>&1)
  assert_contains "force reinstall" "$output" "Installation complete!"
  rm -rf "$T"
)

# --- Test 21: Downgrade blocked without --force ---
(
  echo "--- Test 21: Downgrade blocked without --force ---"
  T=$(mktemp -d)
  _do_install "$T"
  echo "99.0.0" > "$T/store/VERSION"
  output=$(bash "$GC_INSTALL" --skip-hooks 2>&1)
  assert_contains "downgrade blocked" "$output" "newer than available"
  rm -rf "$T"
)

# --- Test 22: Downgrade allowed with --force ---
(
  echo "--- Test 22: Downgrade allowed with --force ---"
  T=$(mktemp -d)
  _do_install "$T"
  echo "99.0.0" > "$T/store/VERSION"
  output=$(bash "$GC_INSTALL" --skip-hooks --force 2>&1)
  assert_contains "force downgrade" "$output" "Installation complete!"
  ver=$(tr -d '[:space:]' < "$T/store/VERSION")
  assert_eq "VERSION downgraded" "1.0.0" "$ver"
  rm -rf "$T"
)

echo ""
counts=$(cat "$RESULT_FILE")
PASS=$(echo "$counts" | cut -d' ' -f1)
FAIL=$(echo "$counts" | cut -d' ' -f2)
echo "=============================="
echo "Upgrade: $PASS passed, $FAIL failed"
echo "=============================="
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
