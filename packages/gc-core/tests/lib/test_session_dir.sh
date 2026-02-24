#!/usr/bin/env bash
set -euo pipefail

# Resolve paths relative to the repo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Create a temporary directory to serve as GC_ROOT for testing
TEST_TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TEST_TMPDIR"' EXIT

# Override the storage root so tests don't touch the real store
export CLAUDE_CONTEXT_PATH="$TEST_TMPDIR"

# Source the function under test (this also sources paths.sh and sanitize.sh)
source "$REPO_ROOT/src/lib/session_dir.sh"

PASS=0
FAIL=0

assert_eq() {
  local description="$1"
  local expected="$2"
  local actual="$3"

  if [[ "$actual" == "$expected" ]]; then
    PASS=$((PASS + 1))
    printf "  PASS: %s\n" "$description"
  else
    FAIL=$((FAIL + 1))
    printf "  FAIL: %s\n" "$description"
    printf "    expected: '%s'\n" "$expected"
    printf "    actual:   '%s'\n" "$actual"
  fi
}

assert_dir_exists() {
  local description="$1"
  local path="$2"

  if [[ -d "$path" ]]; then
    PASS=$((PASS + 1))
    printf "  PASS: %s\n" "$description"
  else
    FAIL=$((FAIL + 1))
    printf "  FAIL: %s (directory does not exist: %s)\n" "$description" "$path"
  fi
}

assert_file_exists() {
  local description="$1"
  local path="$2"

  if [[ -f "$path" ]]; then
    PASS=$((PASS + 1))
    printf "  PASS: %s\n" "$description"
  else
    FAIL=$((FAIL + 1))
    printf "  FAIL: %s (file does not exist: %s)\n" "$description" "$path"
  fi
}

assert_file_not_exists() {
  local description="$1"
  local path="$2"

  if [[ ! -f "$path" ]]; then
    PASS=$((PASS + 1))
    printf "  PASS: %s\n" "$description"
  else
    FAIL=$((FAIL + 1))
    printf "  FAIL: %s (file should not exist: %s)\n" "$description" "$path"
  fi
}

printf "=== test_session_dir.sh ===\n\n"

# -----------------------------------------------------------------------
# Acceptance Test 1: Basic session directory creation with .lock file
# -----------------------------------------------------------------------
printf "%s\n" "-- Test 1: Basic session directory creation --"

result="$(gc_ensure_session_dir "proj-abc123" "test-session-1")"
expected_dir="$GC_EVENTS_DIR/proj-abc123/test-session-1"

assert_eq "returns correct directory path" "$expected_dir" "$result"
assert_dir_exists "directory exists" "$result"
assert_file_exists ".lock file exists" "$result/.lock"

# -----------------------------------------------------------------------
# Acceptance Test 2: Idempotent -- call again, no error, same result
# -----------------------------------------------------------------------
printf "\n%s\n" "-- Test 2: Idempotent re-invocation --"

result2="$(gc_ensure_session_dir "proj-abc123" "test-session-1")"
assert_eq "second call returns same path" "$result" "$result2"
assert_dir_exists "directory still exists" "$result2"
assert_file_exists ".lock file still exists" "$result2/.lock"

# -----------------------------------------------------------------------
# Acceptance Test 3: Session ID with slashes -- slashes stripped (not replaced)
# -----------------------------------------------------------------------
printf "\n%s\n" "-- Test 3: Slashes stripped from session ID --"

result3="$(gc_ensure_session_dir "proj-abc123" "session/bad")"
expected_dir3="$GC_EVENTS_DIR/proj-abc123/sessionbad"

assert_eq "slashes stripped: session/bad -> sessionbad" "$expected_dir3" "$result3"
assert_dir_exists "sanitized directory exists" "$result3"
assert_file_exists ".lock file exists in sanitized dir" "$result3/.lock"

# -----------------------------------------------------------------------
# Acceptance Test 4: Parallel invocations complete without error
# -----------------------------------------------------------------------
printf "\n%s\n" "-- Test 4: Parallel invocations --"

parallel_session="parallel-test-session"
parallel_pid1=""
parallel_pid2=""
parallel_ok=true

# Run two invocations in parallel
gc_ensure_session_dir "proj-abc123" "$parallel_session" > /dev/null &
parallel_pid1=$!
gc_ensure_session_dir "proj-abc123" "$parallel_session" > /dev/null &
parallel_pid2=$!

# Wait for both to finish
if ! wait "$parallel_pid1"; then
  parallel_ok=false
fi
if ! wait "$parallel_pid2"; then
  parallel_ok=false
fi

if $parallel_ok; then
  PASS=$((PASS + 1))
  printf "  PASS: parallel invocations completed without error\n"
else
  FAIL=$((FAIL + 1))
  printf "  FAIL: parallel invocations had errors\n"
fi

parallel_dir="$GC_EVENTS_DIR/proj-abc123/$parallel_session"
assert_dir_exists "parallel: directory exists" "$parallel_dir"
assert_file_exists "parallel: .lock file exists" "$parallel_dir/.lock"

# -----------------------------------------------------------------------
# Acceptance Test 5: Lock file is .lock (not _seq.lock or lock)
# -----------------------------------------------------------------------
printf "\n%s\n" "-- Test 5: Canonical lock file name --"

canon_dir="$(gc_ensure_session_dir "proj-abc123" "canon-test")"

assert_file_exists ".lock exists (canonical name)" "$canon_dir/.lock"
assert_file_not_exists "_seq.lock does NOT exist" "$canon_dir/_seq.lock"
assert_file_not_exists "lock (no dot) does NOT exist" "$canon_dir/lock"

# -----------------------------------------------------------------------
# Additional tests
# -----------------------------------------------------------------------

printf "\n%s\n" "-- Test 6: Different project IDs create separate directories --"

dir_a="$(gc_ensure_session_dir "proj-aaa" "shared-session")"
dir_b="$(gc_ensure_session_dir "proj-bbb" "shared-session")"

assert_eq "different projects: dir_a path" "$GC_EVENTS_DIR/proj-aaa/shared-session" "$dir_a"
assert_eq "different projects: dir_b path" "$GC_EVENTS_DIR/proj-bbb/shared-session" "$dir_b"
assert_dir_exists "project A directory exists" "$dir_a"
assert_dir_exists "project B directory exists" "$dir_b"
assert_file_exists "project A .lock exists" "$dir_a/.lock"
assert_file_exists "project B .lock exists" "$dir_b/.lock"

printf "\n%s\n" "-- Test 7: Path traversal in session ID is sanitized --"

result7="$(gc_ensure_session_dir "proj-abc123" "../../../etc/passwd")"
expected_dir7="$GC_EVENTS_DIR/proj-abc123/etcpasswd"

assert_eq "path traversal sanitized" "$expected_dir7" "$result7"
assert_dir_exists "sanitized path traversal dir exists" "$result7"

printf "\n%s\n" "-- Test 8: Empty session ID falls back to unknown-{uuid} --"

result8="$(gc_ensure_session_dir "proj-abc123" "")"
# Extract the basename of the returned directory
result8_basename="$(basename "$result8")"

if [[ "$result8_basename" =~ ^unknown-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  PASS=$((PASS + 1))
  printf "  PASS: %s\n" "empty session ID -> unknown-{uuid}"
else
  FAIL=$((FAIL + 1))
  printf "  FAIL: %s\n" "empty session ID -> unknown-{uuid}"
  printf "    actual basename: '%s'\n" "$result8_basename"
fi
assert_dir_exists "unknown directory exists" "$result8"
assert_file_exists "unknown .lock exists" "$result8/.lock"

printf "\n%s\n" "-- Test 9: Session ID with dots is sanitized --"

result9="$(gc_ensure_session_dir "proj-abc123" "session.with.dots")"
expected_dir9="$GC_EVENTS_DIR/proj-abc123/sessionwithdots"

assert_eq "dots stripped" "$expected_dir9" "$result9"
assert_dir_exists "dot-sanitized dir exists" "$result9"

printf "\n%s\n" "-- Test 10: GC_EVENTS_DIR is correctly derived from CLAUDE_CONTEXT_PATH --"

assert_eq "GC_EVENTS_DIR uses test tmpdir" "$TEST_TMPDIR/events" "$GC_EVENTS_DIR"

printf "\n%s\n" "-- Test 11: Lock file is a regular file --"

lock_path="$canon_dir/.lock"
if [[ -f "$lock_path" && ! -d "$lock_path" && ! -L "$lock_path" ]]; then
  PASS=$((PASS + 1))
  printf "  PASS: .lock is a regular file (not dir, not symlink)\n"
else
  FAIL=$((FAIL + 1))
  printf "  FAIL: .lock is not a regular file\n"
fi

printf "\n%s\n" "-- Test 12: More parallel invocations (4 processes) --"

many_parallel_session="many-parallel-test"
pids=()
many_ok=true

for i in 1 2 3 4; do
  gc_ensure_session_dir "proj-abc123" "$many_parallel_session" > /dev/null &
  pids+=($!)
done

for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    many_ok=false
  fi
done

if $many_ok; then
  PASS=$((PASS + 1))
  printf "  PASS: 4 parallel invocations completed without error\n"
else
  FAIL=$((FAIL + 1))
  printf "  FAIL: some parallel invocations failed\n"
fi

many_dir="$GC_EVENTS_DIR/proj-abc123/$many_parallel_session"
assert_dir_exists "4-parallel: directory exists" "$many_dir"
assert_file_exists "4-parallel: .lock file exists" "$many_dir/.lock"

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi

exit 0
