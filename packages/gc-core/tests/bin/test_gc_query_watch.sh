#!/usr/bin/env bash
set -euo pipefail

# test_gc_query_watch.sh -- Tests for gc-query watch subcommand

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GC_INSTALL="$PROJECT_ROOT/src/bin/gc-install"
GC_QUERY="$PROJECT_ROOT/src/bin/gc-query"

RESULT_FILE=$(mktemp)
echo "0 0" > "$RESULT_FILE"
trap 'rm -f "$RESULT_FILE"' EXIT

_record_pass() {
  local counts p f
  counts=$(cat "$RESULT_FILE"); p=$(echo "$counts" | cut -d' ' -f1); f=$(echo "$counts" | cut -d' ' -f2)
  echo "$((p + 1)) $f" > "$RESULT_FILE"
}
_record_fail() {
  local counts p f
  counts=$(cat "$RESULT_FILE"); p=$(echo "$counts" | cut -d' ' -f1); f=$(echo "$counts" | cut -d' ' -f2)
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

assert_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if ! echo "$haystack" | grep -qF "$needle"; then echo "  PASS: $label"; _record_pass
  else echo "  FAIL: $label"; echo "    should not contain: $needle"; _record_fail; fi
}

# Setup helper
_setup_env() {
  local t="$1"
  export CLAUDE_CONTEXT_PATH="$t/store" HOME="$t/home"
  mkdir -p "$HOME/.claude"
  bash "$GC_INSTALL" --skip-hooks >/dev/null 2>&1

  source "$PROJECT_ROOT/src/lib/paths.sh"
  PROJECT_ID="$(gc_derive_project_id "$PWD")"
}

_write_event() {
  local dir="$1" seq="$2" type="$3" data="$4"
  local padded
  padded=$(printf '%06d' "$seq")
  local ts="2026-02-16T10:00:$(printf '%02d' "$seq").000Z"
  jq -n --arg type "$type" --argjson seq "$seq" --arg ts "$ts" --argjson data "$data" \
    '{event_type:$type,sequence:$seq,timestamp:$ts,data:$data}' > "$dir/$padded.json"
}

echo "=== gc-query watch tests ==="

# --- Test 1: --help works ---
echo ""
echo "--- Test 1: --help ---"
(
  T=$(mktemp -d)
  _setup_env "$T"
  output=$("$T/store/bin/gc-query" watch --help 2>&1)
  assert_contains "help mentions usage" "$output" "Usage: gc-query watch"
  assert_contains "help mentions Ctrl+C" "$output" "Ctrl+C"
  rm -rf "$T"
)

# --- Test 2: Shows existing events ---
echo ""
echo "--- Test 2: Shows existing events ---"
(
  T=$(mktemp -d)
  _setup_env "$T"
  SID="sess-test-exist"
  EDIR="$T/store/events/$PROJECT_ID/$SID"
  mkdir -p "$EDIR"
  _write_event "$EDIR" 1 "SessionStarted" '{"cwd":"/tmp/proj"}'
  _write_event "$EDIR" 2 "UserPromptReceived" '{"prompt":"Hello"}'
  _write_event "$EDIR" 3 "ToolCallRequested" '{"tool_name":"Read","tool_input":{"file_path":"/a.js"}}'

  output=$(timeout 3 "$T/store/bin/gc-query" watch "$SID" --interval 1 2>&1) || true
  assert_contains "shows session header" "$output" "Session:  $SID"
  assert_contains "shows SessionStarted" "$output" "SessionStarted"
  assert_contains "shows cwd" "$output" "/tmp/proj"
  assert_contains "shows prompt" "$output" "Hello"
  assert_contains "shows tool name" "$output" "Read /a.js"
  assert_contains "shows caught up" "$output" "Caught up (3 events"
  rm -rf "$T"
)

# --- Test 3: Detects new events ---
echo ""
echo "--- Test 3: Detects new events during poll ---"
(
  T=$(mktemp -d)
  _setup_env "$T"
  SID="sess-test-live"
  EDIR="$T/store/events/$PROJECT_ID/$SID"
  mkdir -p "$EDIR"
  _write_event "$EDIR" 1 "SessionStarted" '{"cwd":"/tmp"}'

  # Start watch in background
  "$T/store/bin/gc-query" watch "$SID" --interval 1 > "$T/out.txt" 2>&1 &
  WPID=$!

  sleep 2
  _write_event "$EDIR" 2 "UserPromptReceived" '{"prompt":"New event"}'
  sleep 2
  kill $WPID 2>/dev/null; wait $WPID 2>/dev/null || true

  output=$(cat "$T/out.txt")
  assert_contains "detects new event" "$output" "New event"
  rm -rf "$T"
)

# --- Test 4: Auto-stops on SessionEnded ---
echo ""
echo "--- Test 4: Auto-stops on SessionEnded ---"
(
  T=$(mktemp -d)
  _setup_env "$T"
  SID="sess-test-end"
  EDIR="$T/store/events/$PROJECT_ID/$SID"
  mkdir -p "$EDIR"
  _write_event "$EDIR" 1 "SessionStarted" '{"cwd":"/tmp"}'

  "$T/store/bin/gc-query" watch "$SID" --interval 1 > "$T/out.txt" 2>&1 &
  WPID=$!

  sleep 2
  _write_event "$EDIR" 2 "SessionEnded" '{}'
  sleep 2
  # Process should have exited on its own
  if ! kill -0 $WPID 2>/dev/null; then
    echo "  PASS: watch exited after SessionEnded"
    _record_pass
  else
    echo "  FAIL: watch should have exited after SessionEnded"
    _record_fail
    kill $WPID 2>/dev/null; wait $WPID 2>/dev/null || true
  fi

  output=$(cat "$T/out.txt")
  assert_contains "shows session ended summary" "$output" "Session ended"
  rm -rf "$T"
)

# --- Test 5: Counts tool calls and failures ---
echo ""
echo "--- Test 5: Tool call and failure counting ---"
(
  T=$(mktemp -d)
  _setup_env "$T"
  SID="sess-test-count"
  EDIR="$T/store/events/$PROJECT_ID/$SID"
  mkdir -p "$EDIR"
  _write_event "$EDIR" 1 "SessionStarted" '{"cwd":"/tmp"}'
  _write_event "$EDIR" 2 "ToolCallRequested" '{"tool_name":"Read","tool_input":{"file_path":"/a.js"}}'
  _write_event "$EDIR" 3 "ToolCallCompleted" '{"tool_name":"Read"}'
  _write_event "$EDIR" 4 "ToolCallRequested" '{"tool_name":"Bash","tool_input":{"command":"npm test"}}'
  _write_event "$EDIR" 5 "ToolCallFailed" '{"tool_name":"Bash","error":"exit 1"}'

  "$T/store/bin/gc-query" watch "$SID" --interval 1 > "$T/out.txt" 2>&1 &
  WPID=$!

  sleep 2
  _write_event "$EDIR" 6 "SessionEnded" '{}'
  sleep 2
  wait $WPID 2>/dev/null || true

  output=$(cat "$T/out.txt")
  assert_contains "counts 2 tool calls" "$output" "2 tool calls"
  assert_contains "counts 1 failure" "$output" "1 failures"
  assert_contains "shows FAILED" "$output" "FAILED"
  rm -rf "$T"
)

# --- Test 6: Error on nonexistent session ---
echo ""
echo "--- Test 6: Error on nonexistent session ---"
(
  T=$(mktemp -d)
  _setup_env "$T"
  exit_code=0
  output=$("$T/store/bin/gc-query" watch "nonexistent-session" 2>&1) || exit_code=$?
  assert_eq "exits non-zero" "1" "$([ $exit_code -ne 0 ] && echo 1 || echo 0)"
  rm -rf "$T"
)

# --- Summary ---
echo ""
counts=$(cat "$RESULT_FILE")
PASS=$(echo "$counts" | cut -d' ' -f1)
FAIL=$(echo "$counts" | cut -d' ' -f2)
echo "=============================="
echo "Results: $PASS passed, $FAIL failed"
echo "=============================="
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
