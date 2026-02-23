#!/usr/bin/env bash
# Tests for gc_atomic_write (Task 03/04)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Use a temp directory as the context store so we don't touch real data
TEST_DIR="$(mktemp -d)"
export CLAUDE_CONTEXT_PATH="$TEST_DIR/store"

# Source the module under test
source "$PROJECT_ROOT/src/lib/atomic_write.sh"

PASS=0
FAIL=0

pass() {
  PASS=$((PASS + 1))
  echo "  PASS: $1"
}

fail() {
  FAIL=$((FAIL + 1))
  echo "  FAIL: $1" >&2
}

cleanup() {
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

echo "=== Test: gc_atomic_write basic write ==="
mkdir -p "$TEST_DIR/basic"
gc_atomic_write "$TEST_DIR/basic/hello.json" '{"msg":"hello"}'
if [[ -f "$TEST_DIR/basic/hello.json" ]]; then
  actual="$(cat "$TEST_DIR/basic/hello.json")"
  if [[ "$actual" == '{"msg":"hello"}' ]]; then
    pass "file exists with correct content"
  else
    fail "content mismatch: got '$actual'"
  fi
else
  fail "file does not exist"
fi

echo "=== Test: no leftover temp files after success ==="
leftover="$(find "$TEST_DIR/basic" -name '*.tmp.*' 2>/dev/null | wc -l)"
if [[ "$leftover" -eq 0 ]]; then
  pass "no temp files remain"
else
  fail "found $leftover leftover temp files"
fi

echo "=== Test: write to non-existent directory fails ==="
if gc_atomic_write "$TEST_DIR/nonexistent/dir/file.json" '{"fail":true}' 2>/dev/null; then
  fail "should have returned non-zero"
else
  pass "returned non-zero for missing directory"
fi

# Verify no partial file was left behind
if [[ -e "$TEST_DIR/nonexistent" ]]; then
  fail "partial artifacts were created"
else
  pass "no partial file or directory created"
fi

echo "=== Test: overwrite existing file ==="
mkdir -p "$TEST_DIR/overwrite"
echo "original" > "$TEST_DIR/overwrite/data.json"
gc_atomic_write "$TEST_DIR/overwrite/data.json" "updated"
actual="$(cat "$TEST_DIR/overwrite/data.json")"
if [[ "$actual" == "updated" ]]; then
  pass "overwrote file with new content"
else
  fail "content mismatch after overwrite: got '$actual'"
fi

echo "=== Test: fsync=true still works ==="
mkdir -p "$TEST_DIR/fsync"
gc_atomic_write "$TEST_DIR/fsync/synced.json" '{"synced":true}' true
if [[ -f "$TEST_DIR/fsync/synced.json" ]]; then
  actual="$(cat "$TEST_DIR/fsync/synced.json")"
  if [[ "$actual" == '{"synced":true}' ]]; then
    pass "fsync=true write succeeded with correct content"
  else
    fail "content mismatch with fsync: got '$actual'"
  fi
else
  fail "file does not exist after fsync write"
fi

echo "=== Test: concurrent writes -- last writer wins, file is valid ==="
mkdir -p "$TEST_DIR/concurrent"
# Launch two writes in background subshells
(
  source "$PROJECT_ROOT/src/lib/atomic_write.sh"
  gc_atomic_write "$TEST_DIR/concurrent/race.json" '{"writer":"A"}'
) &
pid_a=$!
(
  source "$PROJECT_ROOT/src/lib/atomic_write.sh"
  gc_atomic_write "$TEST_DIR/concurrent/race.json" '{"writer":"B"}'
) &
pid_b=$!
wait "$pid_a" || true
wait "$pid_b" || true

if [[ -f "$TEST_DIR/concurrent/race.json" ]]; then
  actual="$(cat "$TEST_DIR/concurrent/race.json")"
  if [[ "$actual" == '{"writer":"A"}' ]] || [[ "$actual" == '{"writer":"B"}' ]]; then
    pass "concurrent write: file has valid content from one writer ($actual)"
  else
    fail "concurrent write: file has unexpected/corrupt content: '$actual'"
  fi
else
  fail "concurrent write: file does not exist"
fi

echo "=== Test: crash simulation -- target is never partial ==="
mkdir -p "$TEST_DIR/crash"
original_content='{"version":"original"}'
echo -n "$original_content" > "$TEST_DIR/crash/target.json"

# Generate large content (512KB) -- enough that a write takes measurable time
large_content="$(python3 -c "print('x' * (512 * 1024))" 2>/dev/null || printf '%0.s_' $(seq 1 524288))"

# Start a background write and kill it
(
  source "$PROJECT_ROOT/src/lib/atomic_write.sh"
  gc_atomic_write "$TEST_DIR/crash/target.json" "$large_content"
) &
crash_pid=$!

# Small sleep to let the write start, then kill -9
sleep 0.01
kill -9 "$crash_pid" 2>/dev/null || true
wait "$crash_pid" 2>/dev/null || true

# The target file must be either the original or the complete new content -- never partial
if [[ -f "$TEST_DIR/crash/target.json" ]]; then
  actual="$(cat "$TEST_DIR/crash/target.json")"
  actual_len=${#actual}
  large_len=${#large_content}
  orig_len=${#original_content}

  if [[ "$actual" == "$original_content" ]]; then
    pass "crash: target retained original content"
  elif [[ "$actual_len" -eq "$large_len" ]]; then
    pass "crash: write completed before kill (target has full new content)"
  else
    fail "crash: target has partial content (length=$actual_len, expected $orig_len or $large_len)"
  fi
else
  # File was removed -- shouldn't happen since original existed, but not a partial state
  fail "crash: target file disappeared"
fi

# Clean up any orphaned temp files from crash test
orphans="$(find "$TEST_DIR/crash" -name '*.tmp.*' 2>/dev/null)"
if [[ -n "$orphans" ]]; then
  echo "  INFO: found orphaned temp file(s) from crash (expected): $orphans"
  # These are safe to clean up
  echo "$orphans" | xargs rm -f
fi

echo "=== Test: empty content ==="
mkdir -p "$TEST_DIR/empty"
gc_atomic_write "$TEST_DIR/empty/blank.json" ""
if [[ -f "$TEST_DIR/empty/blank.json" ]]; then
  actual="$(cat "$TEST_DIR/empty/blank.json")"
  if [[ -z "$actual" ]]; then
    pass "empty content write succeeded"
  else
    fail "expected empty file, got: '$actual'"
  fi
else
  fail "empty content file not created"
fi

echo "=== Test: content with special characters ==="
mkdir -p "$TEST_DIR/special"
special_content=$'line1\nline2\n\ttabbed\n{"key":"val with spaces"}'
gc_atomic_write "$TEST_DIR/special/special.json" "$special_content"
actual="$(cat "$TEST_DIR/special/special.json")"
if [[ "$actual" == "$special_content" ]]; then
  pass "special characters preserved"
else
  fail "special characters mangled"
fi

echo ""
echo "================================="
echo "Results: $PASS passed, $FAIL failed"
echo "================================="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
