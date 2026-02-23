#!/usr/bin/env bash
# test_gc_init.sh -- Tests for src/bin/gc-init
# Exit 0 on success, non-zero on failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GC_INIT="$PROJECT_ROOT/src/bin/gc-init"

# Temp directory for all test stores, cleaned up on exit
TEST_DIR=$(mktemp -d)

# Use temp file to track pass/fail across subshells
RESULT_FILE=$(mktemp)
echo "0 0" > "$RESULT_FILE"

trap 'rm -rf "$TEST_DIR" "$RESULT_FILE"' EXIT

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

pass() {
  _record_pass
  echo "  PASS: $1"
}

fail() {
  _record_fail
  echo "  FAIL: $1" >&2
}

assert_eq() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$label"
  else
    fail "$label (expected: '$expected', actual: '$actual')"
  fi
}

assert_contains() {
  local label="$1"
  local haystack="$2"
  local needle="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    pass "$label"
  else
    fail "$label (expected to contain: '$needle', actual: '$haystack')"
  fi
}

# ===================================================================
echo "=== Test 1: gc-init on clean system creates all directories and files ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/t1"
  output=$("$GC_INIT" 2>&1)

  # Root directory exists
  if [[ -d "$CLAUDE_CONTEXT_PATH" ]]; then
    pass "root directory created"
  else
    fail "root directory not created"
  fi

  # events/ exists
  if [[ -d "$CLAUDE_CONTEXT_PATH/events" ]]; then
    pass "events/ created"
  else
    fail "events/ not created"
  fi

  # projections/ exists
  if [[ -d "$CLAUDE_CONTEXT_PATH/projections" ]]; then
    pass "projections/ created"
  else
    fail "projections/ not created"
  fi

  # bin/ exists
  if [[ -d "$CLAUDE_CONTEXT_PATH/bin" ]]; then
    pass "bin/ created"
  else
    fail "bin/ not created"
  fi

  # config.json exists
  if [[ -f "$CLAUDE_CONTEXT_PATH/config.json" ]]; then
    pass "config.json created"
  else
    fail "config.json not created"
  fi
)

# ===================================================================
echo ""
echo "=== Test 2: Root directory has permission 700 ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/t2"
  "$GC_INIT" >/dev/null 2>&1

  perms=$(stat -c '%a' "$CLAUDE_CONTEXT_PATH")
  assert_eq "root dir permissions are 700" "700" "$perms"
)

# ===================================================================
echo ""
echo "=== Test 3: events/ and projections/ have permission 700 ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/t3"
  "$GC_INIT" >/dev/null 2>&1

  perms_events=$(stat -c '%a' "$CLAUDE_CONTEXT_PATH/events")
  assert_eq "events/ permissions are 700" "700" "$perms_events"

  perms_proj=$(stat -c '%a' "$CLAUDE_CONTEXT_PATH/projections")
  assert_eq "projections/ permissions are 700" "700" "$perms_proj"
)

# ===================================================================
echo ""
echo "=== Test 4: bin/ has permission 755 ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/t4"
  "$GC_INIT" >/dev/null 2>&1

  perms_bin=$(stat -c '%a' "$CLAUDE_CONTEXT_PATH/bin")
  assert_eq "bin/ permissions are 755" "755" "$perms_bin"
)

# ===================================================================
echo ""
echo "=== Test 5: config.json has permission 600 ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/t5"
  "$GC_INIT" >/dev/null 2>&1

  perms_config=$(stat -c '%a' "$CLAUDE_CONTEXT_PATH/config.json")
  assert_eq "config.json permissions are 600" "600" "$perms_config"
)

# ===================================================================
echo ""
echo "=== Test 6: config.json has all default fields ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/t6"
  "$GC_INIT" >/dev/null 2>&1

  config_file="$CLAUDE_CONTEXT_PATH/config.json"

  # Check version
  version=$(jq -r '.version' "$config_file")
  assert_eq "config version is 1.0.0" "1.0.0" "$version"

  # Check created_at exists and is ISO 8601
  created_at=$(jq -r '.created_at' "$config_file")
  if echo "$created_at" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; then
    pass "created_at is ISO 8601 format"
  else
    fail "created_at is not ISO 8601: $created_at"
  fi

  # Check storage_path
  storage_path=$(jq -r '.storage_path' "$config_file")
  assert_eq "config storage_path matches" "$CLAUDE_CONTEXT_PATH" "$storage_path"

  # Check checksum
  checksum=$(jq -r '.checksum' "$config_file")
  assert_eq "config checksum is false" "false" "$checksum"
)

# ===================================================================
echo ""
echo "=== Test 7: No sessions.json or .sessions.lock (Amendment 1) ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/t7"
  "$GC_INIT" >/dev/null 2>&1

  if [[ -f "$CLAUDE_CONTEXT_PATH/sessions.json" ]]; then
    fail "sessions.json should NOT exist (Amendment 1)"
  else
    pass "no sessions.json (Amendment 1)"
  fi

  if [[ -f "$CLAUDE_CONTEXT_PATH/.sessions.lock" ]]; then
    fail ".sessions.lock should NOT exist (Amendment 1)"
  else
    pass "no .sessions.lock (Amendment 1)"
  fi
)

# ===================================================================
echo ""
echo "=== Test 8: Idempotency -- run gc-init twice, config.json not overwritten ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/t8"
  "$GC_INIT" >/dev/null 2>&1

  config_file="$CLAUDE_CONTEXT_PATH/config.json"
  original_created_at=$(jq -r '.created_at' "$config_file")

  sleep 1

  output=$("$GC_INIT" 2>&1)

  new_created_at=$(jq -r '.created_at' "$config_file")
  assert_eq "config.json not overwritten on second run" "$original_created_at" "$new_created_at"

  assert_contains "output says already exists" "$output" "already exists"
)

# ===================================================================
echo ""
echo "=== Test 9: CLAUDE_CONTEXT_PATH override ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/custom-path"
  "$GC_INIT" >/dev/null 2>&1

  if [[ -d "$TEST_DIR/custom-path" ]]; then
    pass "store created at custom path"
  else
    fail "store not created at custom path"
  fi

  if [[ -d "$TEST_DIR/custom-path/events" ]]; then
    pass "events/ created at custom path"
  else
    fail "events/ not created at custom path"
  fi

  if [[ -f "$TEST_DIR/custom-path/config.json" ]]; then
    pass "config.json created at custom path"
  else
    fail "config.json not created at custom path"
  fi
)

# ===================================================================
echo ""
echo "=== Test 10: Orphan *.tmp.* files in events/ are cleaned ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/t10"
  # Pre-create events dir with an orphan temp file
  mkdir -p "$CLAUDE_CONTEXT_PATH/events"
  touch "$CLAUDE_CONTEXT_PATH/events/some-event.tmp.12345"
  mkdir -p "$CLAUDE_CONTEXT_PATH/events/project-abc123/session1"
  touch "$CLAUDE_CONTEXT_PATH/events/project-abc123/session1/event.tmp.99999"

  "$GC_INIT" >/dev/null 2>&1

  # Check orphan files are gone
  orphans=$(find "$CLAUDE_CONTEXT_PATH/events" -name '*.tmp.*' 2>/dev/null | wc -l)
  assert_eq "orphan tmp files cleaned" "0" "$orphans"
)

# ===================================================================
echo ""
echo "=== Test 11: Exit code is 0 on success ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/t11"
  if "$GC_INIT" >/dev/null 2>&1; then
    pass "exit code is 0"
  else
    fail "exit code is non-zero"
  fi
)

# ===================================================================
echo ""
echo "=== Test 12: Summary output mentions the store path ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/t12"
  output=$("$GC_INIT" 2>&1)

  assert_contains "output mentions store path" "$output" "$CLAUDE_CONTEXT_PATH"
  assert_contains "output mentions Initializing" "$output" "Initializing GlobalContext store"
  assert_contains "output mentions Store ready" "$output" "Store ready at"
)

# ===================================================================
echo ""
echo "=== Test 13: Idempotency -- directories keep correct permissions on rerun ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/t13"
  "$GC_INIT" >/dev/null 2>&1

  # Intentionally change permissions
  chmod 777 "$CLAUDE_CONTEXT_PATH"
  chmod 777 "$CLAUDE_CONTEXT_PATH/events"

  # Re-run init -- should restore correct permissions
  "$GC_INIT" >/dev/null 2>&1

  perms_root=$(stat -c '%a' "$CLAUDE_CONTEXT_PATH")
  assert_eq "root permissions restored to 700" "700" "$perms_root"

  perms_events=$(stat -c '%a' "$CLAUDE_CONTEXT_PATH/events")
  assert_eq "events/ permissions restored to 700" "700" "$perms_events"
)

# ===================================================================
echo ""
echo "=== Test 14: Writability check works ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/t14"
  "$GC_INIT" >/dev/null 2>&1

  # No leftover write-test files
  leftover=$(find "$CLAUDE_CONTEXT_PATH" -name '.gc-init-write-test.*' 2>/dev/null | wc -l)
  assert_eq "no leftover write-test files" "0" "$leftover"
)

# ===================================================================
echo ""
echo "=== Test 15: Disk space check passes (normal filesystem) ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_DIR/t15"
  # On a normal filesystem there should be >10MB free, so gc-init should succeed
  if "$GC_INIT" >/dev/null 2>&1; then
    pass "disk space check passes on normal filesystem"
  else
    fail "disk space check unexpectedly failed"
  fi
)

# ===================================================================
# Summary
# ===================================================================
echo ""
counts=$(cat "$RESULT_FILE")
PASS=$(echo "$counts" | cut -d' ' -f1)
FAIL=$(echo "$counts" | cut -d' ' -f2)

echo "=============================="
echo "Results: $PASS passed, $FAIL failed"
echo "=============================="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
