#!/usr/bin/env bash
set -euo pipefail

# test_config.sh -- Unit tests for src/lib/config.sh
# Exit 0 on success, non-zero on failure.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONFIG_SH="$PROJECT_ROOT/src/lib/config.sh"

# Use temp files to track pass/fail across subshells
RESULT_FILE=$(mktemp)
echo "0 0" > "$RESULT_FILE"

# Temp directory for test store, cleaned up on exit
TEST_STORE=$(mktemp -d)
trap 'rm -rf "$TEST_STORE" "$RESULT_FILE"' EXIT

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

assert_zero_exit() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "  PASS: $label"
    _record_pass
  else
    echo "  FAIL: $label (expected exit 0, got non-zero)"
    _record_fail
  fi
}

assert_nonzero_exit() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "  FAIL: $label (expected non-zero exit, got 0)"
    _record_fail
  else
    echo "  PASS: $label"
    _record_pass
  fi
}

# ===================================================================
echo "=== Test 1: gc_config_create creates file with all default fields ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_STORE/t1"
  mkdir -p "$CLAUDE_CONTEXT_PATH"
  source "$CONFIG_SH"

  gc_config_create

  # File must exist
  if [[ -f "$GC_CONFIG_FILE" ]]; then
    echo "  PASS: config.json created"
    _record_pass
  else
    echo "  FAIL: config.json not created"
    _record_fail
  fi

  # Check version field
  val=$(jq -r '.version' "$GC_CONFIG_FILE")
  assert_eq "version is 1.0.0" "1.0.0" "$val"

  # Check created_at field exists and is ISO 8601
  val=$(jq -r '.created_at' "$GC_CONFIG_FILE")
  if echo "$val" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; then
    echo "  PASS: created_at is ISO 8601 format"
    _record_pass
  else
    echo "  FAIL: created_at is not ISO 8601 format: $val"
    _record_fail
  fi

  # Check storage_path
  val=$(jq -r '.storage_path' "$GC_CONFIG_FILE")
  assert_eq "storage_path matches GC_ROOT" "$GC_ROOT" "$val"

  # Check checksum
  val=$(jq -r '.checksum' "$GC_CONFIG_FILE")
  assert_eq "checksum is false" "false" "$val"

  # Confirm retention_days is NOT present (Amendment 4)
  if jq -e '.retention_days' "$GC_CONFIG_FILE" >/dev/null 2>&1; then
    echo "  FAIL: retention_days should not be present"
    _record_fail
  else
    echo "  PASS: retention_days not present (Amendment 4)"
    _record_pass
  fi

  # Confirm max_event_size_bytes is NOT present (CQRS note)
  if jq -e '.max_event_size_bytes' "$GC_CONFIG_FILE" >/dev/null 2>&1; then
    echo "  FAIL: max_event_size_bytes should not be present"
    _record_fail
  else
    echo "  PASS: max_event_size_bytes not present (CQRS note)"
    _record_pass
  fi
)

# ===================================================================
echo ""
echo "=== Test 2: gc_config_create does not overwrite existing file ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_STORE/t2"
  mkdir -p "$CLAUDE_CONTEXT_PATH"
  source "$CONFIG_SH"

  gc_config_create
  original_created_at=$(jq -r '.created_at' "$GC_CONFIG_FILE")

  # Wait briefly so any new timestamp would differ
  sleep 1

  gc_config_create
  new_created_at=$(jq -r '.created_at' "$GC_CONFIG_FILE")

  assert_eq "created_at unchanged after second gc_config_create" \
    "$original_created_at" "$new_created_at"
)

# ===================================================================
echo ""
echo "=== Test 3: gc_config_read version returns 1.0.0 ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_STORE/t3"
  mkdir -p "$CLAUDE_CONTEXT_PATH"
  source "$CONFIG_SH"

  gc_config_create
  val=$(gc_config_read version)
  assert_eq "gc_config_read version" "1.0.0" "$val"
)

# ===================================================================
echo ""
echo "=== Test 4: gc_config_read storage_path returns store root ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_STORE/t4"
  mkdir -p "$CLAUDE_CONTEXT_PATH"
  source "$CONFIG_SH"

  gc_config_create
  val=$(gc_config_read storage_path)
  assert_eq "gc_config_read storage_path" "$GC_ROOT" "$val"
)

# ===================================================================
echo ""
echo "=== Test 5: gc_config_read errors when config.json missing ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_STORE/t5"
  mkdir -p "$CLAUDE_CONTEXT_PATH"
  source "$CONFIG_SH"

  # Do NOT create config, just try to read
  set +e
  output=$(gc_config_read version 2>&1)
  exit_code=$?
  set -e

  if [[ $exit_code -ne 0 ]]; then
    echo "  PASS: gc_config_read exits non-zero when config missing"
    _record_pass
  else
    echo "  FAIL: gc_config_read should exit non-zero when config missing"
    _record_fail
  fi

  assert_contains "error message mentions not initialized" \
    "$output" "GlobalContext store not initialized. Run gc-init."
)

# ===================================================================
echo ""
echo "=== Test 6: gc_config_read errors on corrupt config.json ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_STORE/t6"
  mkdir -p "$CLAUDE_CONTEXT_PATH"
  source "$CONFIG_SH"

  # Write invalid JSON
  echo "{invalid json" > "$GC_CONFIG_FILE"

  set +e
  output=$(gc_config_read version 2>&1)
  exit_code=$?
  set -e

  if [[ $exit_code -ne 0 ]]; then
    echo "  PASS: gc_config_read exits non-zero on corrupt config"
    _record_pass
  else
    echo "  FAIL: gc_config_read should exit non-zero on corrupt config"
    _record_fail
  fi

  assert_contains "error message mentions corrupt" \
    "$output" "config.json is corrupt"
)

# ===================================================================
echo ""
echo "=== Test 7: gc_config_create preserves custom fields (no overwrite) ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_STORE/t7"
  mkdir -p "$CLAUDE_CONTEXT_PATH"
  source "$CONFIG_SH"

  gc_config_create

  # Add a custom field manually
  jq '. + {"custom_field": "value"}' "$GC_CONFIG_FILE" > "${GC_CONFIG_FILE}.tmp"
  mv "${GC_CONFIG_FILE}.tmp" "$GC_CONFIG_FILE"

  # Call gc_config_create again -- file should NOT be overwritten
  gc_config_create

  custom_val=$(jq -r '.custom_field' "$GC_CONFIG_FILE")
  assert_eq "custom_field preserved after second gc_config_create" "value" "$custom_val"
)

# ===================================================================
echo ""
echo "=== Test 8: gc_config_validate returns 0 for valid, 1 for corrupt ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_STORE/t8a"
  mkdir -p "$CLAUDE_CONTEXT_PATH"
  source "$CONFIG_SH"

  gc_config_create
  assert_zero_exit "gc_config_validate returns 0 for valid config" gc_config_validate
)
(
  export CLAUDE_CONTEXT_PATH="$TEST_STORE/t8b"
  mkdir -p "$CLAUDE_CONTEXT_PATH"
  source "$CONFIG_SH"

  # Write corrupt JSON
  echo "{broken" > "$GC_CONFIG_FILE"
  assert_nonzero_exit "gc_config_validate returns 1 for corrupt config" gc_config_validate
)
(
  export CLAUDE_CONTEXT_PATH="$TEST_STORE/t8c"
  mkdir -p "$CLAUDE_CONTEXT_PATH"
  source "$CONFIG_SH"

  # No config file at all
  assert_nonzero_exit "gc_config_validate returns 1 when config missing" gc_config_validate
)

# ===================================================================
echo ""
echo "=== Test 9: gc_config_validate fails when required field missing ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_STORE/t9"
  mkdir -p "$CLAUDE_CONTEXT_PATH"
  source "$CONFIG_SH"

  gc_config_create

  # Remove the 'checksum' field
  jq 'del(.checksum)' "$GC_CONFIG_FILE" > "${GC_CONFIG_FILE}.tmp"
  mv "${GC_CONFIG_FILE}.tmp" "$GC_CONFIG_FILE"

  assert_nonzero_exit "gc_config_validate returns 1 when required field removed" gc_config_validate
)

# ===================================================================
echo ""
echo "=== Test 10: gc_config_read returns default for missing field ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_STORE/t10"
  mkdir -p "$CLAUDE_CONTEXT_PATH"
  source "$CONFIG_SH"

  gc_config_create

  # Remove the 'checksum' field from config
  jq 'del(.checksum)' "$GC_CONFIG_FILE" > "${GC_CONFIG_FILE}.tmp"
  mv "${GC_CONFIG_FILE}.tmp" "$GC_CONFIG_FILE"

  val=$(gc_config_read checksum)
  assert_eq "gc_config_read returns default for missing checksum" "false" "$val"
)

# ===================================================================
echo ""
echo "=== Test 11: gc_config_read reads checksum field correctly ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_STORE/t11"
  mkdir -p "$CLAUDE_CONTEXT_PATH"
  source "$CONFIG_SH"

  gc_config_create
  val=$(gc_config_read checksum)
  assert_eq "gc_config_read checksum" "false" "$val"
)

# ===================================================================
echo ""
echo "=== Test 12: Unknown fields preserved (reader ignores them) ==="
# ===================================================================
(
  export CLAUDE_CONTEXT_PATH="$TEST_STORE/t12"
  mkdir -p "$CLAUDE_CONTEXT_PATH"
  source "$CONFIG_SH"

  gc_config_create

  # Add unknown field
  jq '. + {"experimental_feature": true}' "$GC_CONFIG_FILE" > "${GC_CONFIG_FILE}.tmp"
  mv "${GC_CONFIG_FILE}.tmp" "$GC_CONFIG_FILE"

  # gc_config_validate should still pass (unknown fields are fine)
  assert_zero_exit "gc_config_validate passes with unknown fields" gc_config_validate

  # Reading a known field still works
  val=$(gc_config_read version)
  assert_eq "gc_config_read version still works with unknown fields" "1.0.0" "$val"
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

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
