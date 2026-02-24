#!/usr/bin/env bash
# test_codeguard_hook.sh — Tests for the agentctx-codeguard PreToolUse hook.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../../src/scripts/agentctx-codeguard"
DEFAULT_RULES="$SCRIPT_DIR/../../src/codeguard/default-rules.json"

PASS=0
FAIL=0
ERRORS=()

# Setup temp environment
TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

setup_env() {
  local testdir="$TMPDIR_BASE/$1"
  mkdir -p "$testdir/.agentctx"
  mkdir -p "$testdir/project/.git"
  mkdir -p "$testdir/project/.claude"
  export AGENTCTX_HOME="$testdir/.agentctx"
  export TEST_PROJECT="$testdir/project"
  # Copy default rules as global rules
  cp "$DEFAULT_RULES" "$AGENTCTX_HOME/codeguard-rules.json"
}

# Helper: build a Write payload
write_payload() {
  local filepath="$1"
  local content="$2"
  jq -n --arg fp "$filepath" --arg c "$content" \
    '{tool_input: {file_path: $fp, content: $c}}'
}

# Helper: build an Edit payload
edit_payload() {
  local filepath="$1"
  local new_string="$2"
  jq -n --arg fp "$filepath" --arg ns "$new_string" \
    '{tool_input: {file_path: $fp, new_string: $ns}}'
}

run_test() {
  local name="$1"
  local expected_exit="$2"
  local payload="$3"
  local actual_exit

  output=$(printf '%s' "$payload" | bash "$HOOK" 2>&1)
  actual_exit=$?

  if [ "$actual_exit" -eq "$expected_exit" ]; then
    echo "  PASS  $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $name (expected exit $expected_exit, got $actual_exit)"
    if [ -n "$output" ]; then
      echo "        output: $output"
    fi
    FAIL=$((FAIL + 1))
    ERRORS+=("$name")
  fi
}

echo "=== codeguard hook tests ==="
echo ""

# -----------------------------------------------------------------------
# Test 1: No rules file = allow
# -----------------------------------------------------------------------
test_name="no rules file = allow"
tmpdir="$TMPDIR_BASE/t01"
mkdir -p "$tmpdir/.agentctx"
export AGENTCTX_HOME="$tmpdir/.agentctx"
payload=$(write_payload "/some/path/app.ts" 'eval("bad code")')
run_test "$test_name" 0 "$payload"

# -----------------------------------------------------------------------
# Test 2: CORS wildcard = block
# -----------------------------------------------------------------------
setup_env "t02"
payload=$(write_payload "$TEST_PROJECT/src/server.ts" 'app.use(cors({origin: "*"}))')
run_test "cors wildcard = block" 2 "$payload"

# -----------------------------------------------------------------------
# Test 3: eval() = block
# -----------------------------------------------------------------------
setup_env "t03"
payload=$(write_payload "$TEST_PROJECT/src/handler.ts" 'const result = eval("code")')
run_test "eval usage = block" 2 "$payload"

# -----------------------------------------------------------------------
# Test 4: new Function() = block
# -----------------------------------------------------------------------
setup_env "t04"
payload=$(write_payload "$TEST_PROJECT/src/handler.ts" 'const fn = new Function("return 1")')
run_test "new Function = block" 2 "$payload"

# -----------------------------------------------------------------------
# Test 5: Hardcoded secret = block
# -----------------------------------------------------------------------
setup_env "t05"
payload=$(write_payload "$TEST_PROJECT/src/config.ts" 'const password = "SuperSecretP@ss123"')
run_test "hardcoded secret = block" 2 "$payload"

# -----------------------------------------------------------------------
# Test 6: AWS key pattern = block
# -----------------------------------------------------------------------
setup_env "t06"
payload=$(write_payload "$TEST_PROJECT/src/config.ts" 'const key = "AKIAIOSFODNN7EXAMPLE"')
run_test "AWS key pattern = block" 2 "$payload"

# -----------------------------------------------------------------------
# Test 7: Inline suppression = allow
# -----------------------------------------------------------------------
setup_env "t07"
payload=$(write_payload "$TEST_PROJECT/src/handler.ts" '// codeguard:allow eval-usage
const result = eval("safe")')
run_test "inline suppression = allow" 0 "$payload"

# -----------------------------------------------------------------------
# Test 8: Disabled rule = allow
# -----------------------------------------------------------------------
setup_env "t08"
# Disable eval-usage rule
jq '(.rules[] | select(.id == "eval-usage")).enabled = false' \
  "$AGENTCTX_HOME/codeguard-rules.json" > "$AGENTCTX_HOME/codeguard-rules.json.tmp" && \
  mv "$AGENTCTX_HOME/codeguard-rules.json.tmp" "$AGENTCTX_HOME/codeguard-rules.json"
payload=$(write_payload "$TEST_PROJECT/src/handler.ts" 'eval("code")')
run_test "disabled rule = allow" 0 "$payload"

# -----------------------------------------------------------------------
# Test 9: Warn severity = allow (does not block)
# -----------------------------------------------------------------------
setup_env "t09"
payload=$(write_payload "$TEST_PROJECT/src/app.ts" 'app.use(express.json())')
run_test "warn severity = allow" 0 "$payload"

# -----------------------------------------------------------------------
# Test 10: Edit payload (new_string) works
# -----------------------------------------------------------------------
setup_env "t10"
payload=$(edit_payload "$TEST_PROJECT/src/server.ts" 'cors({origin: "*"})')
run_test "edit payload new_string = block" 2 "$payload"

# -----------------------------------------------------------------------
# Test 11: Non-matching file extension = allow
# -----------------------------------------------------------------------
setup_env "t11"
payload=$(write_payload "$TEST_PROJECT/docs/README.md" 'eval("code")')
run_test "non-matching file extension = allow" 0 "$payload"

# -----------------------------------------------------------------------
# Test 12: Test file excluded = allow
# -----------------------------------------------------------------------
setup_env "t12"
payload=$(write_payload "$TEST_PROJECT/src/__tests__/eval.test.ts" 'eval("test code")')
run_test "test file excluded = allow" 0 "$payload"

# -----------------------------------------------------------------------
# Test 13: Project rules override global rules
# -----------------------------------------------------------------------
setup_env "t13"
# Create a project rule that overrides eval-usage to be a warn (not block)
cat > "$TEST_PROJECT/.claude/codeguard-rules.json" <<'EOF'
{
  "version": 1,
  "rules": [
    {
      "id": "eval-usage",
      "description": "eval is ok in this project",
      "severity": "warn",
      "enabled": true,
      "file_patterns": ["*.ts"],
      "patterns": ["\\beval\\s*\\("],
      "exclude_patterns": [],
      "suggestion": "Be careful with eval"
    }
  ]
}
EOF
payload=$(write_payload "$TEST_PROJECT/src/handler.ts" 'eval("code")')
run_test "project override severity = allow" 0 "$payload"

# -----------------------------------------------------------------------
# Test 14: Project disables a global rule
# -----------------------------------------------------------------------
setup_env "t14"
cat > "$TEST_PROJECT/.claude/codeguard-rules.json" <<'EOF'
{
  "version": 1,
  "rules": [
    {
      "id": "eval-usage",
      "description": "eval is ok in this project",
      "severity": "block",
      "enabled": false,
      "file_patterns": ["*.ts"],
      "patterns": ["\\beval\\s*\\("],
      "exclude_patterns": [],
      "suggestion": ""
    }
  ]
}
EOF
payload=$(write_payload "$TEST_PROJECT/src/handler.ts" 'eval("code")')
run_test "project disables global rule = allow" 0 "$payload"

# -----------------------------------------------------------------------
# Test 15: Project adds a new rule
# -----------------------------------------------------------------------
setup_env "t15"
cat > "$TEST_PROJECT/.claude/codeguard-rules.json" <<'EOF'
{
  "version": 1,
  "rules": [
    {
      "id": "no-any-type",
      "description": "TypeScript any type is not allowed",
      "severity": "block",
      "enabled": true,
      "file_patterns": ["*.ts"],
      "patterns": [":\\s*any\\b"],
      "exclude_patterns": [],
      "suggestion": "Use a specific type instead of any"
    }
  ]
}
EOF
payload=$(write_payload "$TEST_PROJECT/src/handler.ts" 'function foo(x: any) {}')
run_test "project adds new rule = block" 2 "$payload"

# -----------------------------------------------------------------------
# Test 16: Empty content = allow
# -----------------------------------------------------------------------
setup_env "t16"
payload=$(jq -n '{tool_input: {file_path: "/some/file.ts", content: ""}}')
run_test "empty content = allow" 0 "$payload"

# -----------------------------------------------------------------------
# Test 17: SQL injection = block
# -----------------------------------------------------------------------
setup_env "t17"
payload=$(write_payload "$TEST_PROJECT/src/db.ts" 'const q = `SELECT * FROM users WHERE id = ${userId}`')
run_test "SQL injection = block" 2 "$payload"

# -----------------------------------------------------------------------
# Test 18: Path traversal = block
# -----------------------------------------------------------------------
setup_env "t18"
payload=$(write_payload "$TEST_PROJECT/src/api.ts" 'const file = path.join(uploadDir, req.params.filename)')
run_test "path traversal = block" 2 "$payload"

# -----------------------------------------------------------------------
# Test 19: Multiple violations reported
# -----------------------------------------------------------------------
setup_env "t19"
content='eval("bad");
const password = "SuperSecret123456";'
payload=$(write_payload "$TEST_PROJECT/src/bad.ts" "$content")
output=$(printf '%s' "$payload" | bash "$HOOK" 2>&1)
actual_exit=$?
# Should block (exit 2) and mention multiple violations
if [ "$actual_exit" -eq 2 ] && echo "$output" | grep -q "2 security violation"; then
  echo "  PASS  multiple violations listed"
  PASS=$((PASS + 1))
else
  echo "  FAIL  multiple violations listed (exit=$actual_exit)"
  FAIL=$((FAIL + 1))
  ERRORS+=("multiple violations listed")
fi

# -----------------------------------------------------------------------
# Test 20: Safe code = allow
# -----------------------------------------------------------------------
setup_env "t20"
payload=$(write_payload "$TEST_PROJECT/src/app.ts" 'const x = 1 + 2;
console.log(x);')
run_test "safe code = allow" 0 "$payload"

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  echo "Failures:"
  for e in "${ERRORS[@]}"; do
    echo "  - $e"
  done
  exit 1
fi
