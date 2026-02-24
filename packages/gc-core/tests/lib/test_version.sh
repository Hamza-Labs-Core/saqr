#!/usr/bin/env bash
set -euo pipefail

# test_version.sh -- Unit tests for src/lib/version.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VERSION_SH="$PROJECT_ROOT/src/lib/version.sh"

RESULT_FILE=$(mktemp)
echo "0 0" > "$RESULT_FILE"
trap 'rm -f "$RESULT_FILE"' EXIT

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

# ===================================================================
echo "=== Test Group 1: gc_get_installed_version ==="
# ===================================================================
(
  source "$VERSION_SH"

  # Test with VERSION file present
  tmpdir=$(mktemp -d)
  echo "1.2.3" > "$tmpdir/VERSION"
  result=$(gc_get_installed_version "$tmpdir")
  assert_eq "reads installed version from VERSION file" "1.2.3" "$result"

  # Test without VERSION file
  rm -f "$tmpdir/VERSION"
  result=$(gc_get_installed_version "$tmpdir")
  assert_eq "returns 0.0.0 when VERSION file missing" "0.0.0" "$result"

  rm -rf "$tmpdir"
)

# ===================================================================
echo ""
echo "=== Test Group 2: gc_get_available_version ==="
# ===================================================================
(
  source "$VERSION_SH"

  # Test with VERSION file in parent dir
  tmpdir=$(mktemp -d)
  mkdir -p "$tmpdir/src"
  echo "2.0.0" > "$tmpdir/VERSION"
  result=$(gc_get_available_version "$tmpdir/src")
  assert_eq "reads available version from parent VERSION file" "2.0.0" "$result"

  # Test without VERSION file
  rm -f "$tmpdir/VERSION"
  result=$(gc_get_available_version "$tmpdir/src")
  assert_eq "returns unknown when VERSION file missing" "unknown" "$result"

  rm -rf "$tmpdir"
)

# ===================================================================
echo ""
echo "=== Test Group 3: gc_version_compare ==="
# ===================================================================
(
  source "$VERSION_SH"

  result=$(gc_version_compare "1.0.0" "1.0.0")
  assert_eq "same versions -> same" "same" "$result"

  result=$(gc_version_compare "1.0.0" "1.0.1")
  assert_eq "patch upgrade -> upgrade" "upgrade" "$result"

  result=$(gc_version_compare "1.0.0" "1.1.0")
  assert_eq "minor upgrade -> upgrade" "upgrade" "$result"

  result=$(gc_version_compare "1.0.0" "2.0.0")
  assert_eq "major upgrade -> upgrade" "upgrade" "$result"

  result=$(gc_version_compare "2.0.0" "1.0.0")
  assert_eq "major downgrade -> downgrade" "downgrade" "$result"

  result=$(gc_version_compare "1.1.0" "1.0.0")
  assert_eq "minor downgrade -> downgrade" "downgrade" "$result"

  result=$(gc_version_compare "1.0.1" "1.0.0")
  assert_eq "patch downgrade -> downgrade" "downgrade" "$result"

  result=$(gc_version_compare "0.0.0" "1.0.0")
  assert_eq "fresh install (0.0.0) -> upgrade" "upgrade" "$result"

  result=$(gc_version_compare "1.0.0" "unknown")
  assert_eq "unknown available -> upgrade" "upgrade" "$result"

  result=$(gc_version_compare "0.0.0" "unknown")
  assert_eq "fresh install with unknown -> upgrade" "upgrade" "$result"
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
