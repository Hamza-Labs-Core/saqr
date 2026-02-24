#!/usr/bin/env bash
set -euo pipefail

# test_deploy.sh -- Unit tests for src/lib/deploy.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEPLOY_SH="$PROJECT_ROOT/src/lib/deploy.sh"

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

assert_file_mode() {
  local label="$1"
  local path="$2"
  local expected_mode="$3"
  local actual_mode
  actual_mode=$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path" 2>/dev/null)
  if [ "$expected_mode" = "$actual_mode" ]; then
    echo "  PASS: $label"
    _record_pass
  else
    echo "  FAIL: $label (expected mode $expected_mode, got $actual_mode)"
    _record_fail
  fi
}

# ===================================================================
echo "=== Test Group 1: Deploy files to temp directory ==="
# ===================================================================
(
  source "$DEPLOY_SH"

  SRC_DIR="$PROJECT_ROOT/src"
  TARGET=$(mktemp -d)

  gc_deploy_files "$SRC_DIR" "$TARGET" false >/dev/null

  # Check bin/ scripts exist with 755
  assert_file_exists "gc-init deployed" "$TARGET/bin/gc-init"
  assert_file_exists "gc-query deployed" "$TARGET/bin/gc-query"
  assert_file_exists "gc-install deployed" "$TARGET/bin/gc-install"
  assert_file_mode "gc-init is 755" "$TARGET/bin/gc-init" "755"
  assert_file_mode "gc-query is 755" "$TARGET/bin/gc-query" "755"

  # Check lib/ modules exist with 644
  assert_file_exists "paths.sh deployed" "$TARGET/lib/paths.sh"
  assert_file_exists "sanitize.sh deployed" "$TARGET/lib/sanitize.sh"
  assert_file_exists "prerequisites.sh deployed" "$TARGET/lib/prerequisites.sh"
  assert_file_mode "paths.sh is 644" "$TARGET/lib/paths.sh" "644"
  assert_file_mode "sanitize.sh is 644" "$TARGET/lib/sanitize.sh" "644"

  # Check VERSION file
  assert_file_exists "VERSION deployed" "$TARGET/VERSION"
  assert_file_mode "VERSION is 644" "$TARGET/VERSION" "644"

  rm -rf "$TARGET"
)

# ===================================================================
echo ""
echo "=== Test Group 2: Deploy twice (upgrade behavior) ==="
# ===================================================================
(
  source "$DEPLOY_SH"

  SRC_DIR="$PROJECT_ROOT/src"
  TARGET=$(mktemp -d)

  gc_deploy_files "$SRC_DIR" "$TARGET" false >/dev/null
  # Modify a file to verify overwrite
  echo "# modified" >> "$TARGET/lib/paths.sh"
  gc_deploy_files "$SRC_DIR" "$TARGET" false >/dev/null

  # Verify the modification is gone (file was overwritten)
  if grep -q "# modified" "$TARGET/lib/paths.sh"; then
    echo "  FAIL: paths.sh was not overwritten on second deploy"
    _record_fail
  else
    echo "  PASS: paths.sh was overwritten on second deploy"
    _record_pass
  fi

  rm -rf "$TARGET"
)

# ===================================================================
echo ""
echo "=== Test Group 3: Dry run ==="
# ===================================================================
(
  source "$DEPLOY_SH"

  SRC_DIR="$PROJECT_ROOT/src"
  TARGET=$(mktemp -d)

  output=$(gc_deploy_files "$SRC_DIR" "$TARGET" true)

  # In dry run, bin/ directory gets created by mkdir -p but no files should be deployed
  # Actually, the dry run does create directories -- let's check that output mentions "Would install"
  if echo "$output" | grep -q "Would install"; then
    echo "  PASS: dry run output mentions Would install"
    _record_pass
  else
    echo "  FAIL: dry run output should mention Would install"
    _record_fail
  fi

  # Verify no script files exist (directories are created by mkdir -p, that's OK)
  if [ -f "$TARGET/bin/gc-init" ]; then
    echo "  FAIL: gc-init should not exist in dry run"
    _record_fail
  else
    echo "  PASS: gc-init not deployed in dry run"
    _record_pass
  fi

  rm -rf "$TARGET"
)

# ===================================================================
echo ""
echo "=== Test Group 4: gc_resolve_src_dir with GC_SRC_DIR ==="
# ===================================================================
(
  tmpdir=$(mktemp -d)
  mkdir -p "$tmpdir/bin" "$tmpdir/lib"
  touch "$tmpdir/bin/test-script"
  touch "$tmpdir/lib/test.sh"

  export GC_SRC_DIR="$tmpdir"
  source "$DEPLOY_SH"
  result=$(gc_resolve_src_dir)
  assert_eq "GC_SRC_DIR override works" "$tmpdir" "$result"

  rm -rf "$tmpdir"
)

# ===================================================================
echo ""
echo "=== Test Group 5: gc_resolve_src_dir fails on bad directory ==="
# ===================================================================
(
  export GC_SRC_DIR="/tmp/nonexistent-gc-src-$$"
  source "$DEPLOY_SH"
  if gc_resolve_src_dir 2>/dev/null; then
    echo "  FAIL: should fail with bad SRC_DIR"
    _record_fail
  else
    echo "  PASS: fails with bad SRC_DIR"
    _record_pass
  fi
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
