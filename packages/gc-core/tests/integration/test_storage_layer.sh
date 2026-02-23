#!/usr/bin/env bash
set -euo pipefail

# test_storage_layer.sh -- End-to-end integration tests for the full storage layer.
# Exercises: gc-init, event writing, per-session metadata, latest symlink,
# projections, config, gc-query store-size, idempotent init, and custom path.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LIB_DIR="$PROJECT_ROOT/src/lib"
BIN_DIR="$PROJECT_ROOT/src/bin"

# ---- Test framework (same pattern as unit tests) ----
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

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
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

assert_gt() {
  local label="$1" actual="$2" threshold="$3"
  if [[ "$actual" -gt "$threshold" ]]; then
    echo "  PASS: $label ($actual > $threshold)"
    _record_pass
  else
    echo "  FAIL: $label ($actual not > $threshold)"
    _record_fail
  fi
}

# ---- Helper: create a fresh store and set up env ----
_make_store() {
  local tmpdir
  tmpdir="$(mktemp -d)"
  _cleanup_files+=("$tmpdir")
  printf '%s' "$tmpdir"
}

# =====================================================================
echo "=== Integration Test 1: Init and verify ==="
# =====================================================================
(
  STORE=$(_make_store)
  export CLAUDE_CONTEXT_PATH="$STORE"

  # Run gc-init
  output=$(bash "$BIN_DIR/gc-init" 2>&1)

  # Verify all directories exist
  assert_true "root dir exists" test -d "$STORE"
  assert_true "events/ exists" test -d "$STORE/events"
  assert_true "projections/ exists" test -d "$STORE/projections"
  assert_true "bin/ exists" test -d "$STORE/bin"
  assert_true "config.json exists" test -f "$STORE/config.json"

  # Verify NO sessions.json or .sessions.lock (Amendment 1)
  assert_false "no sessions.json" test -f "$STORE/sessions.json"
  assert_false "no .sessions.lock" test -f "$STORE/.sessions.lock"

  # Verify permissions
  root_perms=$(stat -c '%a' "$STORE")
  events_perms=$(stat -c '%a' "$STORE/events")
  proj_perms=$(stat -c '%a' "$STORE/projections")
  bin_perms=$(stat -c '%a' "$STORE/bin")
  config_perms=$(stat -c '%a' "$STORE/config.json")

  assert_eq "root perms 700" "700" "$root_perms"
  assert_eq "events perms 700" "700" "$events_perms"
  assert_eq "projections perms 700" "700" "$proj_perms"
  assert_eq "bin perms 755" "755" "$bin_perms"
  assert_eq "config perms 600" "600" "$config_perms"
)

# =====================================================================
echo ""
echo "=== Integration Test 2: Write and read back 100 events across 3 sessions (2 projects) ==="
# =====================================================================
(
  STORE=$(_make_store)
  export CLAUDE_CONTEXT_PATH="$STORE"
  bash "$BIN_DIR/gc-init" >/dev/null 2>&1

  source "$LIB_DIR/event_write.sh"

  # Project A: /tmp/proj-alpha, sessions s1 (40 events) and s2 (30 events)
  # Project B: /tmp/proj-beta, session s3 (30 events)

  proj_a="/tmp/proj-alpha"
  proj_b="/tmp/proj-beta"

  # Derive project IDs
  pid_a=$(gc_derive_project_id "$proj_a")
  pid_b=$(gc_derive_project_id "$proj_b")

  # Write 40 events for session s1 in project A
  for i in $(seq 1 40); do
    GC_PROJECT_DIR="$proj_a" gc_write_event "s1" "TurnCompleted" "{\"turn\": $i}" >/dev/null
  done

  # Write 30 events for session s2 in project A
  for i in $(seq 1 30); do
    GC_PROJECT_DIR="$proj_a" gc_write_event "s2" "TurnCompleted" "{\"turn\": $i}" >/dev/null
  done

  # Write 30 events for session s3 in project B
  for i in $(seq 1 30); do
    GC_PROJECT_DIR="$proj_b" gc_write_event "s3" "TurnCompleted" "{\"turn\": $i}" >/dev/null
  done

  # Verify event file counts per session
  s1_dir="$STORE/events/$pid_a/s1"
  s2_dir="$STORE/events/$pid_a/s2"
  s3_dir="$STORE/events/$pid_b/s3"

  s1_count=$(find "$s1_dir" -maxdepth 1 -name '[0-9]*.json' | wc -l)
  s2_count=$(find "$s2_dir" -maxdepth 1 -name '[0-9]*.json' | wc -l)
  s3_count=$(find "$s3_dir" -maxdepth 1 -name '[0-9]*.json' | wc -l)

  assert_eq "s1 has 40 events" "40" "$s1_count"
  assert_eq "s2 has 30 events" "30" "$s2_count"
  assert_eq "s3 has 30 events" "30" "$s3_count"

  total=$((s1_count + s2_count + s3_count))
  assert_eq "total 100 events" "100" "$total"

  # Verify project-id paths exist
  assert_true "project A dir exists" test -d "$STORE/events/$pid_a"
  assert_true "project B dir exists" test -d "$STORE/events/$pid_b"

  # Verify all event files are valid JSON with correct envelope
  all_valid=true
  for f in "$s1_dir"/[0-9]*.json "$s2_dir"/[0-9]*.json "$s3_dir"/[0-9]*.json; do
    if ! jq -e '.event_id and .event_type and .project_id and .session_id and .sequence and .timestamp and .data' "$f" >/dev/null 2>&1; then
      all_valid=false
      break
    fi
  done
  if $all_valid; then
    echo "  PASS: all 100 events have correct envelope"
    _record_pass
  else
    echo "  FAIL: some events have incorrect envelope"
    _record_fail
  fi
)

# =====================================================================
echo ""
echo "=== Integration Test 3: Per-session metadata ==="
# =====================================================================
(
  STORE=$(_make_store)
  export CLAUDE_CONTEXT_PATH="$STORE"
  bash "$BIN_DIR/gc-init" >/dev/null 2>&1

  source "$LIB_DIR/event_write.sh"

  proj="/tmp/proj-meta-test"
  pid=$(gc_derive_project_id "$proj")

  # Write 5 events to session m1, 10 events to session m2
  for i in $(seq 1 5); do
    GC_PROJECT_DIR="$proj" gc_write_event "m1" "TurnCompleted" "{\"n\": $i}" >/dev/null
  done
  for i in $(seq 1 10); do
    GC_PROJECT_DIR="$proj" gc_write_event "m2" "TurnCompleted" "{\"n\": $i}" >/dev/null
  done

  # Verify session.json for m1
  m1_meta="$STORE/events/$pid/m1/session.json"
  m2_meta="$STORE/events/$pid/m2/session.json"

  assert_true "m1 session.json exists" test -f "$m1_meta"
  assert_true "m2 session.json exists" test -f "$m2_meta"

  m1_count=$(jq -r '.event_count' "$m1_meta")
  m2_count=$(jq -r '.event_count' "$m2_meta")

  assert_eq "m1 event_count is 5" "5" "$m1_count"
  assert_eq "m2 event_count is 10" "10" "$m2_count"

  # Verify session IDs in metadata
  m1_sid=$(jq -r '.session_id' "$m1_meta")
  m2_sid=$(jq -r '.session_id' "$m2_meta")
  assert_eq "m1 session_id" "m1" "$m1_sid"
  assert_eq "m2 session_id" "m2" "$m2_sid"

  # Verify project_id in metadata
  m1_pid=$(jq -r '.project_id' "$m1_meta")
  assert_eq "m1 project_id" "$pid" "$m1_pid"
)

# =====================================================================
echo ""
echo "=== Integration Test 4: Latest symlink ==="
# =====================================================================
(
  STORE=$(_make_store)
  export CLAUDE_CONTEXT_PATH="$STORE"
  bash "$BIN_DIR/gc-init" >/dev/null 2>&1

  source "$LIB_DIR/event_write.sh"
  source "$LIB_DIR/latest_symlink.sh"

  proj_a="/tmp/proj-symlink-a"
  proj_b="/tmp/proj-symlink-b"
  pid_a=$(gc_derive_project_id "$proj_a")
  pid_b=$(gc_derive_project_id "$proj_b")

  # Write events to create sessions
  GC_PROJECT_DIR="$proj_a" gc_write_event "sa1" "TurnCompleted" '{"x":1}' >/dev/null
  GC_PROJECT_DIR="$proj_a" gc_write_event "sa2" "TurnCompleted" '{"x":2}' >/dev/null
  GC_PROJECT_DIR="$proj_b" gc_write_event "sb1" "TurnCompleted" '{"x":3}' >/dev/null

  # Update latest symlinks (simulating what a higher-level layer would do)
  gc_update_latest_symlink "$pid_a" "sa2"
  gc_update_latest_symlink "$pid_b" "sb1"

  # Verify per-project latest symlinks
  latest_a=$(gc_read_latest_session_id "$pid_a")
  latest_b=$(gc_read_latest_session_id "$pid_b")

  assert_eq "project A latest is sa2" "sa2" "$latest_a"
  assert_eq "project B latest is sb1" "sb1" "$latest_b"

  # Verify symlink target is relative (not absolute)
  symlink_path_a="$STORE/projections/$pid_a/latest"
  target_a=$(readlink "$symlink_path_a")
  case "$target_a" in
    /*) echo "  FAIL: symlink target is absolute: $target_a"; _record_fail ;;
    *)  echo "  PASS: symlink target is relative"; _record_pass ;;
  esac
)

# =====================================================================
echo ""
echo "=== Integration Test 5: Projection scaffolding ==="
# =====================================================================
(
  STORE=$(_make_store)
  export CLAUDE_CONTEXT_PATH="$STORE"
  bash "$BIN_DIR/gc-init" >/dev/null 2>&1

  source "$LIB_DIR/event_write.sh"
  source "$LIB_DIR/projection_store.sh"

  proj="/tmp/proj-projection-test"
  pid=$(gc_derive_project_id "$proj")

  # Write 5 events
  for i in $(seq 1 5); do
    GC_PROJECT_DIR="$proj" gc_write_event "ps1" "TurnCompleted" "{\"step\": $i}" >/dev/null
  done

  # Write a projection
  gc_write_projection "$pid" "ps1" "timeline" '{"entries": [1,2,3,4,5]}' 5 5

  # Read it back
  content=$(gc_read_projection "$pid" "ps1" "timeline")

  # Verify metadata
  proj_name=$(printf '%s' "$content" | jq -r '._projection')
  proj_pid=$(printf '%s' "$content" | jq -r '._project_id')
  proj_sid=$(printf '%s' "$content" | jq -r '._session_id')
  proj_ec=$(printf '%s' "$content" | jq -r '._event_count')
  proj_ls=$(printf '%s' "$content" | jq -r '._last_sequence')
  proj_ra=$(printf '%s' "$content" | jq -r '._rebuilt_at')

  assert_eq "projection name" "timeline" "$proj_name"
  assert_eq "_project_id in projection" "$pid" "$proj_pid"
  assert_eq "_session_id in projection" "ps1" "$proj_sid"
  assert_eq "_event_count in projection" "5" "$proj_ec"
  assert_eq "_last_sequence in projection" "5" "$proj_ls"

  # Verify _rebuilt_at is ISO 8601 format
  if echo "$proj_ra" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; then
    echo "  PASS: _rebuilt_at is ISO 8601"
    _record_pass
  else
    echo "  FAIL: _rebuilt_at is not ISO 8601: $proj_ra"
    _record_fail
  fi

  # Staleness: should be current (5 events, last_sequence 5)
  if gc_is_projection_stale "$pid" "ps1" "timeline"; then
    echo "  FAIL: projection should be current (not stale)"
    _record_fail
  else
    echo "  PASS: projection is current"
    _record_pass
  fi

  # Write one more event -> projection should become stale
  GC_PROJECT_DIR="$proj" gc_write_event "ps1" "TurnCompleted" '{"step": 6}' >/dev/null

  if gc_is_projection_stale "$pid" "ps1" "timeline"; then
    echo "  PASS: projection is stale after new event"
    _record_pass
  else
    echo "  FAIL: projection should be stale after new event"
    _record_fail
  fi
)

# =====================================================================
echo ""
echo "=== Integration Test 6: Config ==="
# =====================================================================
(
  STORE=$(_make_store)
  export CLAUDE_CONTEXT_PATH="$STORE"
  bash "$BIN_DIR/gc-init" >/dev/null 2>&1

  source "$LIB_DIR/config.sh"

  # Verify config.json fields
  version=$(gc_config_read "version")
  storage=$(gc_config_read "storage_path")
  checksum=$(gc_config_read "checksum")

  assert_eq "config version" "1.0.0" "$version"
  assert_eq "config storage_path" "$STORE" "$storage"
  assert_eq "config checksum" "false" "$checksum"

  # Verify no retention_days or max_event_size_bytes
  raw=$(cat "$STORE/config.json")
  if printf '%s' "$raw" | jq -e '.retention_days' >/dev/null 2>&1; then
    echo "  FAIL: retention_days should not exist"
    _record_fail
  else
    echo "  PASS: no retention_days (Amendment 4)"
    _record_pass
  fi

  if printf '%s' "$raw" | jq -e '.max_event_size_bytes' >/dev/null 2>&1; then
    echo "  FAIL: max_event_size_bytes should not exist"
    _record_fail
  else
    echo "  PASS: no max_event_size_bytes (CQRS note)"
    _record_pass
  fi

  # Validate config
  assert_true "config validates" gc_config_validate
)

# =====================================================================
echo ""
echo "=== Integration Test 7: Store size via gc-query ==="
# =====================================================================
(
  STORE=$(_make_store)
  export CLAUDE_CONTEXT_PATH="$STORE"
  bash "$BIN_DIR/gc-init" >/dev/null 2>&1

  source "$LIB_DIR/event_write.sh"

  proj_a="/tmp/proj-query-a"
  proj_b="/tmp/proj-query-b"

  # Write 10 events in proj_a/session q1, 20 in proj_b/session q2
  for i in $(seq 1 10); do
    GC_PROJECT_DIR="$proj_a" gc_write_event "q1" "TurnCompleted" "{\"n\": $i}" >/dev/null
  done
  for i in $(seq 1 20); do
    GC_PROJECT_DIR="$proj_b" gc_write_event "q2" "TurnCompleted" "{\"n\": $i}" >/dev/null
  done

  # Run gc-query store-size --format json
  json_output=$(bash "$BIN_DIR/gc-query" store-size --format json)

  session_count=$(printf '%s' "$json_output" | jq -r '.session_count')
  total_events=$(printf '%s' "$json_output" | jq -r '.total_events')
  total_size=$(printf '%s' "$json_output" | jq -r '.total_size_bytes')
  store_path=$(printf '%s' "$json_output" | jq -r '.store_path')

  assert_eq "session_count is 2" "2" "$session_count"
  assert_eq "total_events is 30" "30" "$total_events"
  assert_gt "total_size > 0" "$total_size" 0
  assert_eq "store_path matches" "$STORE" "$store_path"

  # Text mode check
  text_output=$(bash "$BIN_DIR/gc-query" store-size)
  assert_contains "text has GlobalContext Store header" "$text_output" "GlobalContext Store"
  assert_contains "text has Sessions line" "$text_output" "Sessions:"
  assert_contains "text has Total events line" "$text_output" "Total events:"
)

# =====================================================================
echo ""
echo "=== Integration Test 8: Idempotent init ==="
# =====================================================================
(
  STORE=$(_make_store)
  export CLAUDE_CONTEXT_PATH="$STORE"

  # First init
  bash "$BIN_DIR/gc-init" >/dev/null 2>&1

  source "$LIB_DIR/event_write.sh"
  proj="/tmp/proj-idempotent"

  # Write some events
  for i in $(seq 1 5); do
    GC_PROJECT_DIR="$proj" gc_write_event "idem-s1" "TurnCompleted" "{\"n\": $i}" >/dev/null
  done

  # Capture config timestamp
  config_before=$(cat "$STORE/config.json")
  created_at_before=$(printf '%s' "$config_before" | jq -r '.created_at')

  # Second init
  bash "$BIN_DIR/gc-init" >/dev/null 2>&1

  # Verify no data loss
  pid=$(gc_derive_project_id "$proj")
  event_count=$(find "$STORE/events/$pid/idem-s1" -maxdepth 1 -name '[0-9]*.json' | wc -l)
  assert_eq "events preserved after second init" "5" "$event_count"

  # Verify config not overwritten
  config_after=$(cat "$STORE/config.json")
  created_at_after=$(printf '%s' "$config_after" | jq -r '.created_at')
  assert_eq "config.json created_at unchanged" "$created_at_before" "$created_at_after"

  # Verify session.json preserved
  meta_ec=$(jq -r '.event_count' "$STORE/events/$pid/idem-s1/session.json")
  assert_eq "session.json event_count preserved" "5" "$meta_ec"
)

# =====================================================================
echo ""
echo "=== Integration Test 9: CLAUDE_CONTEXT_PATH custom path ==="
# =====================================================================
(
  # Run a mini end-to-end against a completely separate store path
  CUSTOM_STORE=$(_make_store)
  export CLAUDE_CONTEXT_PATH="$CUSTOM_STORE"

  # Override HOME to a temp directory so the default-store check is meaningful
  FAKE_HOME=$(_make_store)
  export HOME="$FAKE_HOME"

  # Init
  bash "$BIN_DIR/gc-init" >/dev/null 2>&1
  assert_true "custom store root exists" test -d "$CUSTOM_STORE"
  assert_true "custom store events/ exists" test -d "$CUSTOM_STORE/events"
  assert_true "custom store config.json exists" test -f "$CUSTOM_STORE/config.json"

  # Write events
  source "$LIB_DIR/event_write.sh"
  proj="/tmp/proj-custom-path"

  for i in $(seq 1 3); do
    GC_PROJECT_DIR="$proj" gc_write_event "cp-s1" "TurnCompleted" "{\"n\": $i}" >/dev/null
  done

  # Verify events land in custom path, not default
  pid=$(gc_derive_project_id "$proj")
  assert_true "events in custom store" test -d "$CUSTOM_STORE/events/$pid/cp-s1"

  # Verify session.json
  meta=$(cat "$CUSTOM_STORE/events/$pid/cp-s1/session.json")
  ec=$(printf '%s' "$meta" | jq -r '.event_count')
  assert_eq "event_count in custom store" "3" "$ec"

  # Verify gc-query against custom store
  json=$(bash "$BIN_DIR/gc-query" store-size --format json)
  query_path=$(printf '%s' "$json" | jq -r '.store_path')
  query_events=$(printf '%s' "$json" | jq -r '.total_events')
  assert_eq "gc-query store_path is custom" "$CUSTOM_STORE" "$query_path"
  assert_eq "gc-query total_events is 3" "3" "$query_events"

  # Verify default store was NOT touched
  assert_false "default store NOT created" test -d "$HOME/.claude-context"
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
