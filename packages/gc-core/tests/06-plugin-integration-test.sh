#!/usr/bin/env bash
# GlobalContext Plugin Integration Tests
# Validates the complete plugin works end-to-end.
# Uses a temporary directory for all data to avoid polluting the real environment.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_DIR="$PROJECT_DIR/plugin"

# Temporary test environment
TEST_DIR=$(mktemp -d)
export CLAUDE_CONTEXT_PATH="$TEST_DIR/store"
trap 'rm -rf "$TEST_DIR"' EXIT

PASS=0
FAIL=0

assert() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "[PASS] $desc"
    PASS=$((PASS + 1))
  else
    echo "[FAIL] $desc"
    FAIL=$((FAIL + 1))
  fi
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "[PASS] $desc"
    PASS=$((PASS + 1))
  else
    echo "[FAIL] $desc (expected: $expected, got: $actual)"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo "[PASS] $desc"
    PASS=$((PASS + 1))
  else
    echo "[FAIL] $desc (expected to contain: $needle)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== GlobalContext Plugin Integration Tests ==="
echo "Plugin: $PLUGIN_DIR"
echo "Test store: $CLAUDE_CONTEXT_PATH"
echo ""

# -----------------------------------------------------------------------
# Test 1: Plugin manifest is valid JSON (Task 1)
# -----------------------------------------------------------------------
assert "1. plugin.json is valid JSON" jq . "$PLUGIN_DIR/.claude-plugin/plugin.json"

# -----------------------------------------------------------------------
# Test 2: hooks.json is valid JSON with all 10 hook events (Task 2)
# -----------------------------------------------------------------------
assert "2. hooks.json is valid JSON" jq . "$PLUGIN_DIR/hooks/hooks.json"
HOOK_COUNT=$(jq '.hooks | keys | length' "$PLUGIN_DIR/hooks/hooks.json")
assert_eq "2b. hooks.json has 10 hook events" "10" "$HOOK_COUNT"

# -----------------------------------------------------------------------
# Test 3: hooks.json event types match expected mapping (Task 2)
# -----------------------------------------------------------------------
EXPECTED_EVENTS="PostToolUse PostToolUseFailure PreCompact PreToolUse SessionEnd SessionStart Stop SubagentStart SubagentStop UserPromptSubmit"
ACTUAL_EVENTS=$(jq -r '.hooks | keys | .[]' "$PLUGIN_DIR/hooks/hooks.json" | sort | tr '\n' ' ' | sed 's/ $//')
assert_eq "3. hook event types match expected" "$EXPECTED_EVENTS" "$ACTUAL_EVENTS"

# -----------------------------------------------------------------------
# Test 4: hooks.json async flags are correct (3 sync, 7 async) (Task 2)
# -----------------------------------------------------------------------
SYNC_COUNT=0
for event in SessionStart UserPromptSubmit PreCompact; do
  ASYNC=$(jq -r ".hooks.${event}[0].hooks[0].async" "$PLUGIN_DIR/hooks/hooks.json")
  if [ "$ASYNC" = "false" ]; then
    SYNC_COUNT=$((SYNC_COUNT + 1))
  fi
done
assert_eq "4. 3 sync events (SessionStart, UserPromptSubmit, PreCompact)" "3" "$SYNC_COUNT"

ASYNC_COUNT=0
for event in PreToolUse PostToolUse PostToolUseFailure SubagentStart SubagentStop Stop SessionEnd; do
  ASYNC=$(jq -r ".hooks.${event}[0].hooks[0].async" "$PLUGIN_DIR/hooks/hooks.json")
  if [ "$ASYNC" = "true" ]; then
    ASYNC_COUNT=$((ASYNC_COUNT + 1))
  fi
done
assert_eq "4b. 7 async events" "7" "$ASYNC_COUNT"

# -----------------------------------------------------------------------
# Test 5: hooks.json matchers are correct (Task 2)
# -----------------------------------------------------------------------
MATCHER_COUNT=0
for event in PreToolUse PostToolUse PostToolUseFailure SubagentStart SubagentStop; do
  MATCHER=$(jq -r ".hooks.${event}[0].matcher" "$PLUGIN_DIR/hooks/hooks.json")
  if [ "$MATCHER" = ".*" ]; then
    MATCHER_COUNT=$((MATCHER_COUNT + 1))
  fi
done
assert_eq "5. 5 tool-related hooks have matcher '.*'" "5" "$MATCHER_COUNT"

# -----------------------------------------------------------------------
# Test 6: gc-hook exits 0 when capture-event succeeds (Task 3)
# -----------------------------------------------------------------------
mkdir -p "$CLAUDE_CONTEXT_PATH/events"
EXIT_CODE=0
echo '{"session_id":"int-test-1"}' | "$PLUGIN_DIR/scripts/gc-hook" SessionStarted 2>/dev/null || EXIT_CODE=$?
assert_eq "6. gc-hook exits 0 on success" "0" "$EXIT_CODE"

# -----------------------------------------------------------------------
# Test 7: gc-hook exits 0 when capture-event fails (Task 3)
# -----------------------------------------------------------------------
BROKEN_DIR=$(mktemp -d)
mkdir -p "$BROKEN_DIR/scripts" "$BROKEN_DIR/lib"
cp "$PLUGIN_DIR/scripts/gc-hook" "$BROKEN_DIR/scripts/"
cp "$PLUGIN_DIR/lib/paths.sh" "$BROKEN_DIR/lib/"
cp "$PLUGIN_DIR/lib/debug_log.sh" "$BROKEN_DIR/lib/"
# No capture-event, so it should fail silently
EXIT_CODE=0
echo '{}' | "$BROKEN_DIR/scripts/gc-hook" TestEvent 2>/dev/null || EXIT_CODE=$?
rm -rf "$BROKEN_DIR"
assert_eq "7. gc-hook exits 0 when capture-event fails" "0" "$EXIT_CODE"

# -----------------------------------------------------------------------
# Test 8: gc-hook produces zero stdout (Task 3)
# -----------------------------------------------------------------------
STDOUT=$(echo '{"session_id":"int-test-2"}' | "$PLUGIN_DIR/scripts/gc-hook" TestEvent 2>/dev/null)
assert_eq "8. gc-hook produces zero stdout" "" "$STDOUT"

# -----------------------------------------------------------------------
# Test 9: gc-hook produces zero stderr (GC_DEBUG unset) (Task 3)
# -----------------------------------------------------------------------
STDERR=$(echo '{"session_id":"int-test-3"}' | GC_DEBUG=0 "$PLUGIN_DIR/scripts/gc-hook" TestEvent 2>&1 >/dev/null)
assert_eq "9. gc-hook produces zero stderr (non-debug)" "" "$STDERR"

# -----------------------------------------------------------------------
# Test 10: gc-hook passes event type and stdin correctly (Task 3)
# -----------------------------------------------------------------------
rm -rf "$CLAUDE_CONTEXT_PATH"
mkdir -p "$CLAUDE_CONTEXT_PATH/events"
echo '{"session_id":"pass-test"}' | "$PLUGIN_DIR/scripts/gc-hook" ToolCallCompleted 2>/dev/null
EVENT_FILE=$(find "$CLAUDE_CONTEXT_PATH/events" -name '[0-9]*.json' -not -name 'session.json' 2>/dev/null | head -1)
if [ -n "$EVENT_FILE" ]; then
  ETYPE=$(jq -r '.event_type' "$EVENT_FILE")
  assert_eq "10. event type passed correctly" "ToolCallCompleted" "$ETYPE"
else
  echo "[FAIL] 10. gc-hook passes event type and stdin correctly (no event file found)"
  FAIL=$((FAIL + 1))
fi

# -----------------------------------------------------------------------
# Test 11: Auto-init creates store on first use (Task 4)
# -----------------------------------------------------------------------
rm -rf "$CLAUDE_CONTEXT_PATH"
echo '{"session_id":"autoinit-test"}' | "$PLUGIN_DIR/scripts/gc-hook" SessionStarted 2>/dev/null
assert "11. auto-init creates store on first use" test -d "$CLAUDE_CONTEXT_PATH/events"

# -----------------------------------------------------------------------
# Test 12: Auto-init is idempotent (Task 4)
# -----------------------------------------------------------------------
echo '{"session_id":"autoinit-test"}' | "$PLUGIN_DIR/scripts/gc-hook" SessionStarted 2>/dev/null
assert "12. auto-init is idempotent" test -d "$CLAUDE_CONTEXT_PATH/events"

# -----------------------------------------------------------------------
# Test 13: Auto-init creates config.json with source=plugin (Task 4)
# -----------------------------------------------------------------------
assert "13. config.json exists" test -f "$CLAUDE_CONTEXT_PATH/config.json"
if [ -f "$CLAUDE_CONTEXT_PATH/config.json" ]; then
  SOURCE=$(jq -r '.source' "$CLAUDE_CONTEXT_PATH/config.json")
  assert_eq "13b. config.json has source=plugin" "plugin" "$SOURCE"
fi

# -----------------------------------------------------------------------
# Test 14: All 9 command files exist with valid frontmatter (Task 5)
# -----------------------------------------------------------------------
CMD_COUNT=0
for cmd in last session sessions search replay tail events status doctor; do
  if [ -f "$PLUGIN_DIR/commands/$cmd.md" ]; then
    FIRST=$(head -1 "$PLUGIN_DIR/commands/$cmd.md")
    if [ "$FIRST" = "---" ]; then
      CMD_COUNT=$((CMD_COUNT + 1))
    fi
  fi
done
assert_eq "14. all 9 command files exist with frontmatter" "9" "$CMD_COUNT"

# -----------------------------------------------------------------------
# Test 15: SKILL.md exists with valid frontmatter (Task 6)
# -----------------------------------------------------------------------
assert "15. SKILL.md exists" test -f "$PLUGIN_DIR/skills/context-recovery/SKILL.md"
SKILL_FIRST=$(head -1 "$PLUGIN_DIR/skills/context-recovery/SKILL.md")
assert_eq "15b. SKILL.md has frontmatter" "---" "$SKILL_FIRST"

# -----------------------------------------------------------------------
# Test 16: Agent markdown exists with valid frontmatter (Task 7)
# -----------------------------------------------------------------------
assert "16. context-investigator.md exists" test -f "$PLUGIN_DIR/agents/context-investigator.md"
AGENT_FIRST=$(head -1 "$PLUGIN_DIR/agents/context-investigator.md")
assert_eq "16b. agent has frontmatter" "---" "$AGENT_FIRST"

# -----------------------------------------------------------------------
# Test 17: All library files exist in plugin/lib/ (Task 8)
# -----------------------------------------------------------------------
LIB_COUNT=0
for lib in paths.sh sanitize.sh atomic_write.sh uuid.sh timestamp.sh debug_log.sh json_validate.sh session_dir.sh session_meta.sh event_write.sh latest_symlink.sh session_read.sh projection_check.sh session_resolve.sh context_loader.sh format_context.sh session_chain.sh; do
  if [ -f "$PLUGIN_DIR/lib/$lib" ]; then
    LIB_COUNT=$((LIB_COUNT + 1))
  else
    echo "  Missing lib: $lib"
  fi
done
assert_eq "17. all 17 library files exist" "17" "$LIB_COUNT"

# -----------------------------------------------------------------------
# Test 18: paths.sh resolves GC_ROOT correctly (Task 8)
# -----------------------------------------------------------------------
GC_ROOT_TEST=$(CLAUDE_CONTEXT_PATH="/tmp/gc-test-18" bash -c "source '$PLUGIN_DIR/lib/paths.sh' && echo \$GC_ROOT")
assert_eq "18. paths.sh resolves GC_ROOT" "/tmp/gc-test-18" "$GC_ROOT_TEST"

# -----------------------------------------------------------------------
# Test 19: capture-event sources libraries from plugin lib/ (Task 8)
# -----------------------------------------------------------------------
assert "19. capture-event sources from plugin lib" grep -q 'PLUGIN_ROOT.*lib/' "$PLUGIN_DIR/scripts/capture-event"

# -----------------------------------------------------------------------
# Test 20: marketplace.json is valid JSON (Task 9)
# -----------------------------------------------------------------------
assert "20. marketplace.json is valid JSON" jq . "$PLUGIN_DIR/marketplace.json"

# -----------------------------------------------------------------------
# Test 21: End-to-end: SessionStarted event captures correctly (Tasks 2-4, 8)
# -----------------------------------------------------------------------
rm -rf "$CLAUDE_CONTEXT_PATH"
echo '{"session_id":"e2e-session-1","project_dir":"/tmp/test-project"}' | "$PLUGIN_DIR/scripts/gc-hook" SessionStarted 2>/dev/null
E2E_EVENT=$(find "$CLAUDE_CONTEXT_PATH/events" -name '000001.json' 2>/dev/null | head -1)
if [ -n "$E2E_EVENT" ]; then
  E2E_TYPE=$(jq -r '.event_type' "$E2E_EVENT")
  assert_eq "21. SessionStarted event captured" "SessionStarted" "$E2E_TYPE"
  E2E_SEQ=$(jq -r '.sequence' "$E2E_EVENT")
  assert_eq "21b. sequence is 1" "1" "$E2E_SEQ"
else
  echo "[FAIL] 21. SessionStarted event not found"
  FAIL=$((FAIL + 1))
fi

# -----------------------------------------------------------------------
# Test 22: End-to-end: ToolCallCompleted event captures correctly (Tasks 2-3, 8)
# -----------------------------------------------------------------------
echo '{"session_id":"e2e-session-1","tool_name":"Bash","project_dir":"/tmp/test-project"}' | "$PLUGIN_DIR/scripts/capture-event" ToolCallCompleted 2>/dev/null
E2E_TOOL=$(find "$CLAUDE_CONTEXT_PATH/events" -name '000002.json' 2>/dev/null | head -1)
if [ -n "$E2E_TOOL" ]; then
  TOOL_TYPE=$(jq -r '.event_type' "$E2E_TOOL")
  assert_eq "22. ToolCallCompleted event captured" "ToolCallCompleted" "$TOOL_TYPE"
else
  echo "[FAIL] 22. ToolCallCompleted event not found"
  FAIL=$((FAIL + 1))
fi

# -----------------------------------------------------------------------
# Test 23: End-to-end: all 10 event types produce valid event files (Tasks 2-3, 8)
# -----------------------------------------------------------------------
rm -rf "$CLAUDE_CONTEXT_PATH"
ALL_TYPES=(SessionStarted UserPromptReceived ToolCallRequested ToolCallCompleted ToolCallFailed AgentSpawned AgentCompleted TurnCompleted CompactionTriggered SessionEnded)
ALL_VALID=true
for etype in "${ALL_TYPES[@]}"; do
  echo "{\"session_id\":\"e2e-all-types\",\"project_dir\":\"/tmp/test-project\"}" | "$PLUGIN_DIR/scripts/capture-event" "$etype" 2>/dev/null
done
EVENT_COUNT=$(find "$CLAUDE_CONTEXT_PATH/events" -name '[0-9]*.json' 2>/dev/null | wc -l)
assert_eq "23. all 10 event types produce event files" "10" "$EVENT_COUNT"

# Validate each event file is valid JSON
for f in "$CLAUDE_CONTEXT_PATH"/events/*/*/[0-9]*.json; do
  [ -f "$f" ] || continue
  if ! jq empty "$f" 2>/dev/null; then
    ALL_VALID=false
    break
  fi
done
assert "23b. all event files are valid JSON" $ALL_VALID

# -----------------------------------------------------------------------
# Test 24: CLAUDE_CONTEXT_PATH override works for all operations (Tasks 3-4)
# -----------------------------------------------------------------------
CUSTOM_STORE="$TEST_DIR/custom-store-24"
CLAUDE_CONTEXT_PATH="$CUSTOM_STORE" "$PLUGIN_DIR/scripts/gc-init" 2>/dev/null
assert "24. CLAUDE_CONTEXT_PATH override creates store" test -d "$CUSTOM_STORE/events"
CLAUDE_CONTEXT_PATH="$CUSTOM_STORE" echo '{"session_id":"custom-24"}' | CLAUDE_CONTEXT_PATH="$CUSTOM_STORE" "$PLUGIN_DIR/scripts/capture-event" SessionStarted 2>/dev/null
CUSTOM_EVENT=$(find "$CUSTOM_STORE/events" -name '*.json' -not -name 'session.json' 2>/dev/null | head -1)
assert "24b. events written to custom path" test -n "$CUSTOM_EVENT"

# -----------------------------------------------------------------------
# Test 25: Plugin structure is complete (All)
# -----------------------------------------------------------------------
STRUCTURE_OK=true
for path in \
  ".claude-plugin/plugin.json" \
  "hooks/hooks.json" \
  "scripts/gc-hook" \
  "scripts/capture-event" \
  "scripts/gc-init" \
  "scripts/gc-query" \
  "skills/context-recovery/SKILL.md" \
  "agents/context-investigator.md" \
  "marketplace.json" \
  "README.md" \
  "CHANGELOG.md" \
  "LICENSE"; do
  if [ ! -f "$PLUGIN_DIR/$path" ]; then
    STRUCTURE_OK=false
    echo "  Missing: $path"
  fi
done
assert "25. complete plugin structure" $STRUCTURE_OK

# -----------------------------------------------------------------------
# Test 26: No hardcoded ~/.claude-context/bin/ paths in any script (Tasks 3, 8)
# -----------------------------------------------------------------------
NO_HARDCODED=true
for f in "$PLUGIN_DIR"/scripts/* "$PLUGIN_DIR"/lib/*.sh; do
  [ -f "$f" ] || continue
  if grep -q '~/.claude-context/bin/' "$f" 2>/dev/null; then
    NO_HARDCODED=false
    echo "  Found hardcoded path in: $f"
  fi
  if grep -q '\$HOME/.claude-context/bin/' "$f" 2>/dev/null; then
    NO_HARDCODED=false
    echo "  Found hardcoded path in: $f"
  fi
done
assert "26. no hardcoded ~/.claude-context/bin/ paths" $NO_HARDCODED

# -----------------------------------------------------------------------
# Test 27: Scripts work from arbitrary plugin install location (Tasks 3, 8)
# -----------------------------------------------------------------------
ARB_PLUGIN="$TEST_DIR/arbitrary-location/my-plugin"
mkdir -p "$ARB_PLUGIN"
cp -r "$PLUGIN_DIR"/* "$ARB_PLUGIN/"
cp -r "$PLUGIN_DIR"/.claude-plugin "$ARB_PLUGIN/"
chmod +x "$ARB_PLUGIN/scripts/gc-hook" "$ARB_PLUGIN/scripts/capture-event" "$ARB_PLUGIN/scripts/gc-init" "$ARB_PLUGIN/scripts/gc-query"
ARB_STORE="$TEST_DIR/arb-store-27"
export CLAUDE_CONTEXT_PATH="$ARB_STORE"
echo '{"session_id":"arb-test-27"}' | "$ARB_PLUGIN/scripts/gc-hook" SessionStarted 2>/dev/null
ARB_EVENT=$(find "$ARB_STORE/events" -name '*.json' -not -name 'session.json' 2>/dev/null | head -1)
assert "27. scripts work from arbitrary location" test -n "$ARB_EVENT"

# -----------------------------------------------------------------------
# Test 28: Debug logging (GC_DEBUG=1) writes to log file (Task 3)
# -----------------------------------------------------------------------
DEBUG_STORE="$TEST_DIR/debug-store-28"
export CLAUDE_CONTEXT_PATH="$DEBUG_STORE"
mkdir -p "$DEBUG_STORE/logs"
echo '{"session_id":"debug-test"}' | GC_DEBUG=1 "$PLUGIN_DIR/scripts/gc-hook" SessionStarted 2>/dev/null
assert "28. debug logging writes to log file" test -f "$DEBUG_STORE/logs/hook.log"

# -----------------------------------------------------------------------
# Test 29: gc-query store-size runs from plugin scripts/ (Tasks 5, 8)
# -----------------------------------------------------------------------
export CLAUDE_CONTEXT_PATH="$TEST_DIR/store"
mkdir -p "$CLAUDE_CONTEXT_PATH/events"
STATUS_OUTPUT=$("$PLUGIN_DIR/scripts/gc-query" store-size 2>/dev/null)
assert_contains "29. gc-query store-size runs" "GlobalContext Store" "$STATUS_OUTPUT"

# -----------------------------------------------------------------------
# Test 30: gc-query doctor runs from plugin scripts/ (Tasks 5, 8)
# -----------------------------------------------------------------------
DOCTOR_OUTPUT=$("$PLUGIN_DIR/scripts/gc-query" doctor 2>/dev/null)
assert_contains "30. gc-query doctor runs" "GlobalContext Doctor" "$DOCTOR_OUTPUT"

# -----------------------------------------------------------------------
# Test 31: Story-05 bash libs are sourceable (Task 8 extended)
# -----------------------------------------------------------------------
S05_SOURCEABLE=true
for lib in session_read.sh projection_check.sh session_resolve.sh context_loader.sh format_context.sh session_chain.sh latest_symlink.sh; do
  if ! bash -c "source '$PLUGIN_DIR/lib/$lib'" 2>/dev/null; then
    S05_SOURCEABLE=false
    echo "  Cannot source: $lib"
  fi
done
assert "31. Story-05 bash libs are sourceable" $S05_SOURCEABLE

# -----------------------------------------------------------------------
# Test 32: Node.js projection engine files exist (Task 8 extended)
# -----------------------------------------------------------------------
PROJ_COUNT=0
for f in \
  "lib/projections/lib/paths.mjs" \
  "lib/projections/lib/registry.mjs" \
  "lib/projections/lib/incremental.mjs" \
  "lib/projections/lib/replay.mjs" \
  "lib/projections/lib/formatters.mjs" \
  "lib/projections/lib/utils.mjs" \
  "lib/projections/lib/summary-generators.mjs" \
  "lib/projections/handlers/timeline.mjs" \
  "lib/projections/handlers/files-touched.mjs" \
  "lib/projections/handlers/decisions.mjs" \
  "lib/projections/handlers/summary.mjs" \
  "lib/projections/handlers/context-snapshot.mjs"; do
  if [ -f "$PLUGIN_DIR/$f" ]; then
    PROJ_COUNT=$((PROJ_COUNT + 1))
  else
    echo "  Missing: $f"
  fi
done
assert_eq "32. all 12 projection engine files exist" "12" "$PROJ_COUNT"

# -----------------------------------------------------------------------
# Test 33: project CLI exists and is executable (Task 8 extended)
# -----------------------------------------------------------------------
assert "33. project CLI exists" test -f "$PLUGIN_DIR/scripts/project"
assert "33b. project CLI is executable" test -x "$PLUGIN_DIR/scripts/project"

# -----------------------------------------------------------------------
# Test 34: gc-query subcommands are implemented (not stubs)
# -----------------------------------------------------------------------
NO_STUBS=true
for subcmd in last session sessions search replay tail events; do
  if grep -q "_gc_query_stub.*$subcmd" "$PLUGIN_DIR/scripts/gc-query" 2>/dev/null; then
    NO_STUBS=false
    echo "  Still stubbed: $subcmd"
  fi
done
assert "34. gc-query has no stub subcommands" $NO_STUBS

# -----------------------------------------------------------------------
# Test 35: gc-query sources all Story-05 libs
# -----------------------------------------------------------------------
SOURCES_OK=true
for lib in session_read.sh projection_check.sh session_resolve.sh context_loader.sh format_context.sh session_chain.sh; do
  if ! grep -q "$lib" "$PLUGIN_DIR/scripts/gc-query" 2>/dev/null; then
    SOURCES_OK=false
    echo "  gc-query does not source: $lib"
  fi
done
assert "35. gc-query sources all Story-05 libs" $SOURCES_OK

# -----------------------------------------------------------------------
# Test 36: gc-query status works (replaces old store-size alias test)
# -----------------------------------------------------------------------
export CLAUDE_CONTEXT_PATH="$TEST_DIR/store"
mkdir -p "$CLAUDE_CONTEXT_PATH/events" "$CLAUDE_CONTEXT_PATH/projections"
echo '{"version":"1.0.0","source":"plugin"}' > "$CLAUDE_CONTEXT_PATH/config.json"
STATUS_OUT=$("$PLUGIN_DIR/scripts/gc-query" status 2>/dev/null)
assert_contains "36. gc-query status works" "Store is empty" "$STATUS_OUT"

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
echo ""
echo "========================================="
echo "Results: $PASS passed, $FAIL failed"
echo "========================================="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
