#!/usr/bin/env bash
set -euo pipefail

# test_prerequisites.sh -- Unit tests for src/lib/prerequisites.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PREREQ_SH="$PROJECT_ROOT/src/lib/prerequisites.sh"

# Use temp files to track pass/fail across subshells
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

# Helper: create a mock bin dir with specified tools, excluding listed tools
# Usage: _create_mock_bin exclude_tool1 exclude_tool2 ...
_create_mock_bin() {
  local mock_dir
  mock_dir=$(mktemp -d)
  local excludes=("$@")

  local all_tools=(jq node sha256sum shasum git flock uuidgen)
  local sys_tools=(cat cut awk sed tr date dirname basename find stat wc ls mv rm cp mkdir chmod touch head tail grep sort uniq tee mktemp df readlink id)

  for tool in "${all_tools[@]}"; do
    local skip=false
    for ex in "${excludes[@]}"; do
      if [[ "$tool" == "$ex" ]]; then
        skip=true
        break
      fi
    done
    if [[ "$skip" == "true" ]]; then
      continue
    fi
    local tool_path
    tool_path=$(command -v "$tool" 2>/dev/null || true)
    if [[ -n "$tool_path" ]]; then
      ln -sf "$tool_path" "$mock_dir/$tool"
    fi
  done

  for tool in "${sys_tools[@]}"; do
    local tool_path
    tool_path=$(command -v "$tool" 2>/dev/null || true)
    if [[ -n "$tool_path" ]]; then
      ln -sf "$tool_path" "$mock_dir/$tool"
    fi
  done

  echo "$mock_dir"
}

# ===================================================================
echo "=== Test Group 1: All prerequisites met (normal system) ==="
# ===================================================================
(
  source "$PREREQ_SH"
  gc_check_prerequisites
  exit_code=$?
  assert_eq "gc_check_prerequisites returns 0 when all required met" "0" "$exit_code"
  assert_eq "bash status is ok" "ok" "${PREREQ_STATUS[bash]}"
  assert_eq "jq status is ok" "ok" "${PREREQ_STATUS[jq]}"
  assert_eq "node status is ok" "ok" "${PREREQ_STATUS[node]}"
  assert_eq "sha256sum status is ok" "ok" "${PREREQ_STATUS[sha256sum]}"
  assert_eq "gc_prereq_ok returns 0" "0" "$(gc_prereq_ok; echo $?)"
)

# ===================================================================
echo ""
echo "=== Test Group 2: Report output contains version info ==="
# ===================================================================
(
  source "$PREREQ_SH"
  gc_check_prerequisites
  report=$(gc_print_prereq_report)
  assert_contains "report contains bash" "$report" "bash"
  assert_contains "report contains jq" "$report" "jq"
  assert_contains "report contains node" "$report" "node"
  assert_contains "report contains ok" "$report" "ok"
)

# ===================================================================
echo ""
echo "=== Test Group 3: Missing jq (required) ==="
# ===================================================================
(
  MOCK_BIN=$(_create_mock_bin jq)
  export PATH="$MOCK_BIN"
  source "$PREREQ_SH"
  gc_check_prerequisites || true
  assert_eq "jq status is missing" "missing" "${PREREQ_STATUS[jq]}"
  assert_contains "jq message has install instructions" "${PREREQ_MESSAGE[jq]}" "jq is required but not found"
  assert_eq "gc_prereq_ok returns 1 (jq missing)" "1" "$(gc_prereq_ok; echo $?)"
  rm -rf "$MOCK_BIN"
)

# ===================================================================
echo ""
echo "=== Test Group 4: Mock outdated node (version 16) ==="
# ===================================================================
(
  MOCK_BIN=$(_create_mock_bin node)
  # Create a fake node that reports version 16
  cat > "$MOCK_BIN/node" << 'SCRIPT'
#!/bin/bash
echo "v16.0.0"
SCRIPT
  chmod +x "$MOCK_BIN/node"
  export PATH="$MOCK_BIN"
  source "$PREREQ_SH"
  gc_check_prerequisites || true
  assert_eq "node status is outdated" "outdated" "${PREREQ_STATUS[node]}"
  assert_contains "node message mentions found version" "${PREREQ_MESSAGE[node]}" "found: 16"
  rm -rf "$MOCK_BIN"
)

# ===================================================================
echo ""
echo "=== Test Group 5: Optional flock missing ==="
# ===================================================================
(
  MOCK_BIN=$(_create_mock_bin flock)
  export PATH="$MOCK_BIN"
  source "$PREREQ_SH"
  gc_check_prerequisites
  exit_code=$?
  assert_eq "returns 0 even with flock missing (optional)" "0" "$exit_code"
  assert_eq "flock status is optional_missing" "optional_missing" "${PREREQ_STATUS[flock]}"
  assert_contains "flock message warns about no locking" "${PREREQ_MESSAGE[flock]}" "flock not found"
  rm -rf "$MOCK_BIN"
)

# ===================================================================
echo ""
echo "=== Test Group 6: Optional git missing ==="
# ===================================================================
(
  MOCK_BIN=$(_create_mock_bin git)
  export PATH="$MOCK_BIN"
  source "$PREREQ_SH"
  gc_check_prerequisites
  exit_code=$?
  assert_eq "returns 0 even with git missing (optional)" "0" "$exit_code"
  assert_eq "git status is optional_missing" "optional_missing" "${PREREQ_STATUS[git]}"
  assert_contains "git message is INFO" "${PREREQ_MESSAGE[git]}" "git not found"
  rm -rf "$MOCK_BIN"
)

# ===================================================================
echo ""
echo "=== Test Group 7: Optional uuidgen missing ==="
# ===================================================================
(
  MOCK_BIN=$(_create_mock_bin uuidgen)
  export PATH="$MOCK_BIN"
  source "$PREREQ_SH"
  gc_check_prerequisites
  exit_code=$?
  assert_eq "returns 0 even with uuidgen missing (optional)" "0" "$exit_code"
  assert_eq "uuidgen status is optional_missing" "optional_missing" "${PREREQ_STATUS[uuidgen]}"
  assert_contains "uuidgen message is INFO" "${PREREQ_MESSAGE[uuidgen]}" "uuidgen not found"
  rm -rf "$MOCK_BIN"
)

# ===================================================================
echo ""
echo "=== Test Group 8: Version info populated ==="
# ===================================================================
(
  source "$PREREQ_SH"
  gc_check_prerequisites
  # bash version should contain major.minor
  assert_contains "bash version has dot" "${PREREQ_VERSION[bash]}" "."
  # jq version should be non-empty
  if [ -n "${PREREQ_VERSION[jq]}" ]; then
    echo "  PASS: jq version is non-empty"
    _record_pass
  else
    echo "  FAIL: jq version is empty"
    _record_fail
  fi
  # node version should be non-empty
  if [ -n "${PREREQ_VERSION[node]}" ]; then
    echo "  PASS: node version is non-empty"
    _record_pass
  else
    echo "  FAIL: node version is empty"
    _record_fail
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
