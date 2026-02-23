#!/usr/bin/env bash
set -euo pipefail

# test_crash_recovery.sh -- Crash recovery and orphan cleanup tests.
# Verifies: orphan temp file cleanup during gc-init, rejected events isolation,
# and flock timeout orphan file creation.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LIB_DIR="$PROJECT_ROOT/src/lib"
BIN_DIR="$PROJECT_ROOT/src/bin"

# ---- Test framework ----
RESULT_FILE=$(mktemp)
echo "0 0" > "$RESULT_FILE"

_cleanup_files=()
_cleanup() {
  for d in "${_cleanup_files[@]}"; do
    rm -rf "$d" 2>/dev/null || true
  done
  rm -f "$RESULT_FILE"
}
trap '_cleanup' EXIT

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

assert_true() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "  PASS: $label"
    _record_pass
  else
    echo "  FAIL: $label (command returned non-zero)"
    _record_fail
  fi
}

assert_false() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "  FAIL: $label (expected non-zero, got 0)"
    _record_fail
  else
    echo "  PASS: $label"
    _record_pass
  fi
}

_make_store() {
  local tmpdir
  tmpdir="$(mktemp -d)"
  _cleanup_files+=("$tmpdir")
  printf '%s' "$tmpdir"
}

# =====================================================================
echo "=== Crash Recovery Test 1: Orphan temp files cleaned by gc-init ==="
# =====================================================================
(
  STORE=$(_make_store)
  export CLAUDE_CONTEXT_PATH="$STORE"

  # First init to create structure
  bash "$BIN_DIR/gc-init" >/dev/null 2>&1

  # Create orphan temp files in events/ directory tree
  mkdir -p "$STORE/events/proj-abc123/session-1"
  touch "$STORE/events/proj-abc123/session-1/000003.json.tmp.12345"
  touch "$STORE/events/proj-abc123/session-1/000004.json.tmp.67890"
  mkdir -p "$STORE/events/proj-xyz789/session-2"
  touch "$STORE/events/proj-xyz789/session-2/000001.json.tmp.99999"

  # Verify orphan files exist before cleanup
  orphan_count=$(find "$STORE/events" -name '*.tmp.*' | wc -l)
  assert_eq "3 orphan tmp files before cleanup" "3" "$orphan_count"

  # Run gc-init again -- should clean orphans
  output=$(bash "$BIN_DIR/gc-init" 2>&1)

  # Verify orphan files are gone
  orphan_count_after=$(find "$STORE/events" -name '*.tmp.*' | wc -l)
  assert_eq "0 orphan tmp files after gc-init" "0" "$orphan_count_after"
)

# =====================================================================
echo ""
echo "=== Crash Recovery Test 2: Rejected events do not affect normal operations ==="
# =====================================================================
(
  STORE=$(_make_store)
  export CLAUDE_CONTEXT_PATH="$STORE"
  bash "$BIN_DIR/gc-init" >/dev/null 2>&1

  source "$LIB_DIR/event_write.sh"
  source "$LIB_DIR/rejected.sh"

  proj="/tmp/proj-reject-test"
  pid=$(gc_derive_project_id "$proj")

  # Write 3 normal events
  for i in $(seq 1 3); do
    GC_PROJECT_DIR="$proj" gc_write_event "rej-s1" "TurnCompleted" "{\"n\": $i}" >/dev/null
  done

  # Manually write a rejected event
  gc_write_rejected_event "$pid" "rej-s1" '{"bad": "data"}' "validation failed: missing required field" >/dev/null

  # Write 2 more normal events
  for i in $(seq 4 5); do
    GC_PROJECT_DIR="$proj" gc_write_event "rej-s1" "TurnCompleted" "{\"n\": $i}" >/dev/null
  done

  session_dir="$STORE/events/$pid/rej-s1"

  # Verify sequenced event files
  seq_count=$(find "$session_dir" -maxdepth 1 -name '[0-9]*.json' | wc -l)
  assert_eq "5 sequenced events (rejected did not interfere)" "5" "$seq_count"

  # Verify sequences are 1-5 with no gaps
  sequences=$(for f in "$session_dir"/[0-9]*.json; do
    basename "$f" .json | sed 's/^0*//' | sed 's/^$/0/'
  done | sort -n | tr '\n' ' ' | sed 's/ $//')
  assert_eq "sequences are 1 2 3 4 5" "1 2 3 4 5" "$sequences"

  # Verify session.json event_count
  meta_ec=$(jq -r '.event_count' "$session_dir/session.json")
  assert_eq "session.json event_count is 5" "5" "$meta_ec"

  # Verify rejected file exists in _rejected/
  rejected_count=$(find "$session_dir/_rejected" -name '*.json' | wc -l)
  assert_eq "1 rejected event in _rejected/" "1" "$rejected_count"

  # Verify rejected file has correct structure
  rejected_file=$(find "$session_dir/_rejected" -name '*.json' | head -1)
  reason=$(jq -r '._reason' "$rejected_file")
  assert_eq "rejected file has correct reason" "validation failed: missing required field" "$reason"
)

# =====================================================================
echo ""
echo "=== Crash Recovery Test 3: Flock timeout produces orphan event file ==="
# =====================================================================
(
  STORE=$(_make_store)
  export CLAUDE_CONTEXT_PATH="$STORE"
  bash "$BIN_DIR/gc-init" >/dev/null 2>&1

  source "$LIB_DIR/event_write.sh"

  proj="/tmp/proj-flock-test"
  pid=$(gc_derive_project_id "$proj")

  # Write one event to establish the session directory and lock file
  GC_PROJECT_DIR="$proj" gc_write_event "flock-s1" "TurnCompleted" '{"setup": true}' >/dev/null

  session_dir="$STORE/events/$pid/flock-s1"
  lock_file="$session_dir/.lock"

  # Hold the lock for longer than the 5-second timeout
  lock_ready_marker="$session_dir/.lock-holder-ready"
  rm -f "$lock_ready_marker"
  (
    exec 9>"$lock_file"
    flock 9
    touch "$lock_ready_marker"
    sleep 8
    exec 9>&-
  ) &
  holder_pid=$!

  # Wait deterministically for the lock holder to acquire the lock
  for _i in $(seq 1 100); do
    [ -f "$lock_ready_marker" ] && break
    sleep 0.05
  done
  rm -f "$lock_ready_marker"
  if ! [ -f "$lock_ready_marker" ] 2>/dev/null; then :; fi

  # Attempt to write an event -- should timeout and write orphan
  GC_PROJECT_DIR="$proj" gc_write_event "flock-s1" "TurnCompleted" '{"orphan": true}' >/dev/null 2>/dev/null || true

  # Wait for lock holder to finish
  wait "$holder_pid" 2>/dev/null || true

  # Verify orphan file was created
  orphan_files=$(find "$session_dir" -maxdepth 1 -name 'orphan-*.json' 2>/dev/null)
  orphan_count=$(echo "$orphan_files" | grep -c 'orphan-' || true)

  if [[ "$orphan_count" -ge 1 ]]; then
    echo "  PASS: orphan event file created on flock timeout ($orphan_count found)"
    _record_pass
  else
    echo "  FAIL: no orphan event file created on flock timeout"
    _record_fail
  fi

  # Verify orphan file has valid JSON
  if [[ "$orphan_count" -ge 1 ]]; then
    orphan_file=$(echo "$orphan_files" | head -1)
    if jq -e '.' "$orphan_file" >/dev/null 2>&1; then
      echo "  PASS: orphan file is valid JSON"
      _record_pass
    else
      echo "  FAIL: orphan file is not valid JSON"
      _record_fail
    fi

    # Verify orphan has sequence 0 (unknown)
    orphan_seq=$(jq -r '.sequence' "$orphan_file")
    assert_eq "orphan sequence is 0 (placeholder)" "0" "$orphan_seq"
  fi

  # Verify the original sequenced event (from setup) is still intact
  seq_count=$(find "$session_dir" -maxdepth 1 -name '[0-9]*.json' | wc -l)
  assert_eq "original sequenced event still exists" "1" "$seq_count"
)

# =====================================================================
echo ""
echo "=== Crash Recovery Test 4: gc-init cleans orphans but preserves valid events ==="
# =====================================================================
(
  STORE=$(_make_store)
  export CLAUDE_CONTEXT_PATH="$STORE"
  bash "$BIN_DIR/gc-init" >/dev/null 2>&1

  source "$LIB_DIR/event_write.sh"

  proj="/tmp/proj-init-clean"
  pid=$(gc_derive_project_id "$proj")

  # Write 3 valid events
  for i in $(seq 1 3); do
    GC_PROJECT_DIR="$proj" gc_write_event "clean-s1" "TurnCompleted" "{\"n\": $i}" >/dev/null
  done

  session_dir="$STORE/events/$pid/clean-s1"

  # Place some orphan temp files
  touch "$session_dir/000005.json.tmp.abc"
  touch "$session_dir/000006.json.tmp.def"

  # Run gc-init to clean orphans
  bash "$BIN_DIR/gc-init" >/dev/null 2>&1

  # Verify orphan temp files are gone
  tmp_count=$(find "$session_dir" -name '*.tmp.*' | wc -l)
  assert_eq "orphan tmp files cleaned" "0" "$tmp_count"

  # Verify valid events are preserved
  seq_count=$(find "$session_dir" -maxdepth 1 -name '[0-9]*.json' | wc -l)
  assert_eq "valid events preserved" "3" "$seq_count"

  # Verify session.json preserved
  meta_ec=$(jq -r '.event_count' "$session_dir/session.json")
  assert_eq "session.json preserved" "3" "$meta_ec"
)

# =====================================================================
echo ""
echo "=============================="
counts=$(cat "$RESULT_FILE")
PASS=$(echo "$counts" | cut -d' ' -f1)
FAIL=$(echo "$counts" | cut -d' ' -f2)
echo "Results: $PASS passed, $FAIL failed"
echo "=============================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
