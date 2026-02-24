#!/usr/bin/env bash
set -euo pipefail

# test_concurrent_writes.sh -- Concurrency stress tests for the storage layer.
# Spawns parallel gc_write_event calls and verifies correctness of sequence
# numbering and per-session metadata.

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

_make_store() {
  local tmpdir
  tmpdir="$(mktemp -d)"
  _cleanup_files+=("$tmpdir")
  printf '%s' "$tmpdir"
}

# =====================================================================
echo "=== Concurrent Test 1: 20 parallel writes to same session ==="
# =====================================================================
(
  STORE=$(_make_store)
  export CLAUDE_CONTEXT_PATH="$STORE"
  bash "$BIN_DIR/gc-init" >/dev/null 2>&1

  proj="/tmp/proj-conc1"

  # Create a small helper script that writes a single event
  helper=$(mktemp)
  _cleanup_files+=("$helper")
  cat > "$helper" <<'HELPER_EOF'
#!/usr/bin/env bash
set -euo pipefail
source "$LIB_DIR/event_write.sh"
GC_PROJECT_DIR="$GC_PROJECT_DIR_VAL" gc_write_event "$SESSION_ID" "TurnCompleted" "{\"worker\": $WORKER_ID}" >/dev/null
HELPER_EOF
  chmod +x "$helper"

  # Spawn 20 parallel writers
  pids=()
  for i in $(seq 1 20); do
    (
      export LIB_DIR="$LIB_DIR"
      export CLAUDE_CONTEXT_PATH="$STORE"
      export GC_PROJECT_DIR_VAL="$proj"
      export SESSION_ID="conc-s1"
      export WORKER_ID="$i"
      bash "$helper"
    ) &
    pids+=($!)
  done

  # Wait for all
  for pid in "${pids[@]}"; do
    wait "$pid" || true
  done

  source "$LIB_DIR/paths.sh"
  pid_val=$(gc_derive_project_id "$proj")
  session_dir="$STORE/events/$pid_val/conc-s1"

  # Count sequenced event files
  seq_files=$(find "$session_dir" -maxdepth 1 -name '[0-9]*.json' | wc -l)
  orphan_files=$(find "$session_dir" -maxdepth 1 -name 'orphan-*.json' | wc -l)
  total_files=$((seq_files + orphan_files))

  assert_eq "20 total event files (sequenced + orphans)" "20" "$total_files"

  # Verify sequence numbers in sequenced files have no gaps and no duplicates
  if [[ "$seq_files" -gt 0 ]]; then
    sequences=$(for f in "$session_dir"/[0-9]*.json; do
      basename "$f" .json | sed 's/^0*//' | sed 's/^$/0/'
    done | sort -n)

    unique_count=$(echo "$sequences" | sort -u | wc -l)
    assert_eq "all sequenced files have unique sequences" "$seq_files" "$unique_count"

    # Check 1 through N with no gaps
    first=$(echo "$sequences" | head -1)
    last=$(echo "$sequences" | tail -1)
    assert_eq "sequences start at 1" "1" "$first"
    assert_eq "sequences end at $seq_files" "$seq_files" "$last"

    # Verify no gaps
    expected_seq=$(seq 1 "$seq_files")
    actual_seq=$(echo "$sequences" | tr '\n' ' ')
    expected_seq_str=$(echo "$expected_seq" | tr '\n' ' ')
    if [[ "$actual_seq" == "$expected_seq_str" ]]; then
      echo "  PASS: no gaps in sequence numbers 1-$seq_files"
      _record_pass
    else
      echo "  FAIL: gaps detected in sequence numbers"
      echo "    expected: $expected_seq_str"
      echo "    actual:   $actual_seq"
      _record_fail
    fi
  fi

  # Verify session.json event_count matches total sequenced files
  # (orphans don't increment event_count since they don't acquire the lock)
  meta_ec=$(jq -r '.event_count' "$session_dir/session.json")
  assert_eq "session.json event_count matches sequenced files" "$seq_files" "$meta_ec"
)

# =====================================================================
echo ""
echo "=== Concurrent Test 2: 5 sessions across 2 projects concurrently ==="
# =====================================================================
(
  STORE=$(_make_store)
  export CLAUDE_CONTEXT_PATH="$STORE"
  bash "$BIN_DIR/gc-init" >/dev/null 2>&1

  proj_a="/tmp/proj-multi-a"
  proj_b="/tmp/proj-multi-b"

  # Write helper
  helper=$(mktemp)
  _cleanup_files+=("$helper")
  cat > "$helper" <<'HELPER_EOF'
#!/usr/bin/env bash
set -euo pipefail
source "$LIB_DIR/event_write.sh"
for i in $(seq 1 "$EVENT_COUNT"); do
  GC_PROJECT_DIR="$GC_PROJECT_DIR_VAL" gc_write_event "$SESSION_ID" "TurnCompleted" "{\"i\": $i}" >/dev/null
done
HELPER_EOF
  chmod +x "$helper"

  # 5 sessions: proj_a has s1 (8 events), s2 (6 events), s3 (4 events)
  #             proj_b has s4 (10 events), s5 (7 events)
  declare -A session_events
  session_events[a_s1]=8
  session_events[a_s2]=6
  session_events[a_s3]=4
  session_events[b_s4]=10
  session_events[b_s5]=7

  pids=()
  for key in a_s1 a_s2 a_s3 b_s4 b_s5; do
    ec=${session_events[$key]}
    if [[ "$key" == a_* ]]; then
      proj_dir="$proj_a"
    else
      proj_dir="$proj_b"
    fi
    sid="${key#*_}"  # strip prefix
    (
      export LIB_DIR="$LIB_DIR"
      export CLAUDE_CONTEXT_PATH="$STORE"
      export GC_PROJECT_DIR_VAL="$proj_dir"
      export SESSION_ID="$sid"
      export EVENT_COUNT="$ec"
      bash "$helper"
    ) &
    pids+=($!)
  done

  # Wait for all
  for pid in "${pids[@]}"; do
    wait "$pid" || true
  done

  source "$LIB_DIR/paths.sh"
  pid_a=$(gc_derive_project_id "$proj_a")
  pid_b=$(gc_derive_project_id "$proj_b")

  # Verify each session's event_count independently
  for key in a_s1 a_s2 a_s3 b_s4 b_s5; do
    expected_ec=${session_events[$key]}
    if [[ "$key" == a_* ]]; then
      pid_val="$pid_a"
    else
      pid_val="$pid_b"
    fi
    sid="${key#*_}"
    session_dir="$STORE/events/$pid_val/$sid"

    # Count event files (sequenced + orphans)
    seq_count=$(find "$session_dir" -maxdepth 1 -name '[0-9]*.json' 2>/dev/null | wc -l)
    orphan_count=$(find "$session_dir" -maxdepth 1 -name 'orphan-*.json' 2>/dev/null | wc -l)
    total=$((seq_count + orphan_count))

    assert_eq "session $sid has $expected_ec total event files" "$expected_ec" "$total"

    # Check session.json
    if [[ -f "$session_dir/session.json" ]]; then
      meta_ec=$(jq -r '.event_count' "$session_dir/session.json")
      assert_eq "session $sid session.json event_count = $seq_count" "$seq_count" "$meta_ec"
    else
      echo "  FAIL: session $sid missing session.json"
      _record_fail
    fi
  done
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
