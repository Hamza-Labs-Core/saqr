#!/usr/bin/env bash
set -euo pipefail

# test_gc_doctor.sh -- Tests for gc-doctor command

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GC_INSTALL="$PROJECT_ROOT/src/bin/gc-install"
GC_DOCTOR="$PROJECT_ROOT/src/bin/gc-doctor"

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

# Helper: install to a temp dir
_do_install() {
  local tmpdir="$1"
  export CLAUDE_CONTEXT_PATH="$tmpdir/gc-store"
  export HOME="$tmpdir/home"
  mkdir -p "$HOME/.claude"
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1
}

# ===================================================================
echo "=== Test Group 1: Doctor after clean install ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  _do_install "$TEST_TMPDIR"

  output=$(bash "$GC_DOCTOR" 2>&1)
  exit_code=$?

  assert_eq "doctor exits 0 after clean install" "0" "$exit_code"
  assert_contains "output contains ALL CHECKS PASSED" "$output" "ALL CHECKS PASSED"
  assert_contains "output contains Store" "$output" "Store:"
  assert_contains "output has prerequisites section" "$output" "Prerequisites"
  assert_contains "output has structure section" "$output" "Structure"
  assert_contains "output has write test" "$output" "Write test"
  assert_contains "output has read test" "$output" "Read test"

  rm -rf "$TEST_TMPDIR"
)

# ===================================================================
echo ""
echo "=== Test Group 2: Doctor with bad permissions ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  _do_install "$TEST_TMPDIR"

  # Change permissions
  chmod 777 "$TEST_TMPDIR/gc-store"

  output=$(bash "$GC_DOCTOR" 2>&1 || true)
  assert_contains "detects wrong permissions" "$output" "FAIL"

  # Restore permissions for cleanup
  chmod 700 "$TEST_TMPDIR/gc-store"
  rm -rf "$TEST_TMPDIR"
)

# ===================================================================
echo ""
echo "=== Test Group 3: Doctor JSON output ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  _do_install "$TEST_TMPDIR"

  output=$(bash "$GC_DOCTOR" --json 2>&1)
  exit_code=$?

  assert_eq "json output exits 0" "0" "$exit_code"

  # Validate it's valid JSON
  if echo "$output" | jq -e '.' >/dev/null 2>&1; then
    echo "  PASS: output is valid JSON"
    _record_pass
  else
    echo "  FAIL: output is not valid JSON"
    _record_fail
  fi

  # Check JSON structure
  store_path=$(echo "$output" | jq -r '.store_path')
  assert_eq "JSON store_path matches" "$TEST_TMPDIR/gc-store" "$store_path"

  overall=$(echo "$output" | jq -r '.overall')
  assert_eq "JSON overall is pass" "pass" "$overall"

  checks_count=$(echo "$output" | jq '.checks | length')
  if [ "$checks_count" -gt 0 ]; then
    echo "  PASS: JSON has checks array with $checks_count entries"
    _record_pass
  else
    echo "  FAIL: JSON has no checks"
    _record_fail
  fi

  # Check diagnostics
  if echo "$output" | jq -e '.diagnostics.store_size_bytes' >/dev/null 2>&1; then
    echo "  PASS: JSON has diagnostics.store_size_bytes"
    _record_pass
  else
    echo "  FAIL: JSON missing diagnostics.store_size_bytes"
    _record_fail
  fi

  rm -rf "$TEST_TMPDIR"
)

# ===================================================================
echo ""
echo "=== Test Group 4: Doctor on uninitialized system ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  export CLAUDE_CONTEXT_PATH="$TEST_TMPDIR/nonexistent"
  export HOME="$TEST_TMPDIR/home"
  mkdir -p "$HOME"

  exit_code=0
  output=$(bash "$GC_DOCTOR" 2>&1) || exit_code=$?

  assert_eq "exits non-zero on uninitialized system" "1" "$exit_code"
  assert_contains "detects missing store" "$output" "FAIL"

  rm -rf "$TEST_TMPDIR"
)

# ===================================================================
echo ""
echo "=== Test Group 5: Doctor test event cleanup ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  _do_install "$TEST_TMPDIR"

  bash "$GC_DOCTOR" >/dev/null 2>&1

  # Verify no doctor test directory remains
  if [ -d "$TEST_TMPDIR/gc-store/events/__gc_doctor_test__" ]; then
    echo "  FAIL: doctor test directory not cleaned up"
    _record_fail
  else
    echo "  PASS: doctor test directory cleaned up"
    _record_pass
  fi

  rm -rf "$TEST_TMPDIR"
)

# ===================================================================
echo ""
echo "=== Test Group 6: Doctor --verbose mode ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  _do_install "$TEST_TMPDIR"

  output=$(bash "$GC_DOCTOR" --verbose 2>&1)
  exit_code=$?

  assert_eq "verbose exits 0" "0" "$exit_code"
  assert_contains "verbose output has details" "$output" "PASS"

  rm -rf "$TEST_TMPDIR"
)

# ===================================================================
echo ""
echo "=== Test Group 7: Doctor detects missing VERSION file ==="
# ===================================================================
(
  TEST_TMPDIR=$(mktemp -d)
  _do_install "$TEST_TMPDIR"

  rm -f "$TEST_TMPDIR/gc-store/VERSION"

  output=$(bash "$GC_DOCTOR" 2>&1 || true)
  assert_contains "detects missing VERSION" "$output" "FAIL"

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
