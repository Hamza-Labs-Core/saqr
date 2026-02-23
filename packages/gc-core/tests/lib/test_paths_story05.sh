#!/usr/bin/env bash
# Tests for Task 01: Shared Store Path Resolution Helper (Story 05)
# Verifies paths.sh is correctly sourced by all Story 05 libraries.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1" >&2; }

echo "=== Testing Task 01: paths.sh integration ==="

# Test 1: Default path without CLAUDE_CONTEXT_PATH
echo "Test 1: Default GC_ROOT"
result="$(unset CLAUDE_CONTEXT_PATH; bash -c "source '$PROJECT_ROOT/src/lib/paths.sh'; echo \$GC_ROOT")"
if [[ "$result" == "$HOME/.claude-context" ]]; then pass "Default GC_ROOT"; else fail "Default GC_ROOT: $result"; fi

# Test 2: Custom CLAUDE_CONTEXT_PATH
echo "Test 2: Custom CLAUDE_CONTEXT_PATH"
result="$(CLAUDE_CONTEXT_PATH=/tmp/test-store bash -c "source '$PROJECT_ROOT/src/lib/paths.sh'; echo \$GC_ROOT")"
if [[ "$result" == "/tmp/test-store" ]]; then pass "Custom GC_ROOT"; else fail "Custom GC_ROOT: $result"; fi

# Test 3: Derived paths are consistent
echo "Test 3: Derived paths"
result="$(CLAUDE_CONTEXT_PATH=/tmp/test bash -c "
  source '$PROJECT_ROOT/src/lib/paths.sh'
  echo \$GC_EVENTS_DIR
  echo \$GC_PROJECTIONS_DIR
  echo \$GC_BIN_DIR
  echo \$GC_CONFIG_FILE
")"
expected="/tmp/test/events
/tmp/test/projections
/tmp/test/bin
/tmp/test/config.json"
if [[ "$result" == "$expected" ]]; then pass "All derived paths consistent"; else fail "Derived paths: $result"; fi

# Test 4: gc_derive_project_id format
echo "Test 4: project-id format"
result="$(bash -c "source '$PROJECT_ROOT/src/lib/paths.sh'; gc_derive_project_id /home/user/my-project")"
if echo "$result" | grep -qE '^my-project-[a-f0-9]{6}$'; then
  pass "project-id format: basename-hash6"
else
  fail "project-id format: $result"
fi

# Test 5: All Story 05 libraries source paths.sh (indirect check)
echo "Test 5: Libraries source paths.sh"
for lib in session_read.sh projection_check.sh session_resolve.sh context_loader.sh format_context.sh session_chain.sh; do
  if grep -q 'paths.sh' "$PROJECT_ROOT/src/lib/$lib"; then
    pass "$lib sources paths.sh"
  else
    fail "$lib does not source paths.sh"
  fi
done

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
