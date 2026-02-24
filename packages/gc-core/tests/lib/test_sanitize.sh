#!/usr/bin/env bash
set -euo pipefail

# Resolve paths relative to the repo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source the function under test
source "$REPO_ROOT/src/lib/sanitize.sh"

PASS=0
FAIL=0

assert_eq() {
  local description="$1"
  local expected="$2"
  local actual="$3"

  if [[ "$actual" == "$expected" ]]; then
    PASS=$((PASS + 1))
    printf "  PASS: %s\n" "$description"
  else
    FAIL=$((FAIL + 1))
    printf "  FAIL: %s\n" "$description"
    printf "    expected: '%s'\n" "$expected"
    printf "    actual:   '%s'\n" "$actual"
  fi
}

printf "=== test_sanitize.sh ===\n\n"

# 1. Already valid input
result="$(gc_sanitize_session_id "abc123")"
assert_eq "already valid: abc123" "abc123" "$result"

# 2. Hyphens allowed
result="$(gc_sanitize_session_id "session-2026")"
assert_eq "hyphens allowed: session-2026" "session-2026" "$result"

# 3. Slashes stripped
result="$(gc_sanitize_session_id "session/with/slashes")"
assert_eq "slashes stripped" "sessionwithslashes" "$result"

# 4. Spaces stripped
result="$(gc_sanitize_session_id "has spaces")"
assert_eq "spaces stripped" "hasspaces" "$result"

# 5. Path traversal prevention
result="$(gc_sanitize_session_id "../../../etc/passwd")"
assert_eq "path traversal: ../../../etc/passwd" "etcpasswd" "$result"

# 6. Empty string falls back to "unknown-{uuid}"
result="$(gc_sanitize_session_id "")"
if [[ "$result" =~ ^unknown-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  PASS=$((PASS + 1))
  printf "  PASS: %s\n" "empty string -> unknown-{uuid}"
else
  FAIL=$((FAIL + 1))
  printf "  FAIL: %s\n" "empty string -> unknown-{uuid}"
  printf "    actual:   '%s'\n" "$result"
fi

# 7. Hidden file dot stripped
result="$(gc_sanitize_session_id ".hidden")"
assert_eq "dot stripped: .hidden" "hidden" "$result"

# 8. Long string truncated to 255 characters
long_input="$(printf 'a%.0s' $(seq 1 300))"
result="$(gc_sanitize_session_id "$long_input")"
assert_eq "300-char input truncated to 255" "255" "${#result}"

# 9. Case preserved
result="$(gc_sanitize_session_id "UPPER-case")"
assert_eq "case preserved: UPPER-case" "UPPER-case" "$result"

# 10. Dots inside stripped
result="$(gc_sanitize_session_id "with.dots.inside")"
assert_eq "dots stripped: with.dots.inside" "withdotsinside" "$result"

# 11. Underscores allowed
result="$(gc_sanitize_session_id "under_score")"
assert_eq "underscores allowed: under_score" "under_score" "$result"

# 12. Only disallowed characters -> unknown-{uuid}
result="$(gc_sanitize_session_id "...")"
if [[ "$result" =~ ^unknown-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  PASS=$((PASS + 1))
  printf "  PASS: %s\n" "all dots -> unknown-{uuid}"
else
  FAIL=$((FAIL + 1))
  printf "  FAIL: %s\n" "all dots -> unknown-{uuid}"
  printf "    actual:   '%s'\n" "$result"
fi

# 13. Mixed valid and invalid characters
result="$(gc_sanitize_session_id "a!@#b\$%^c")"
assert_eq "mixed valid/invalid: a!@#b\$%^c -> abc" "abc" "$result"

# 14. Backslash stripped
result="$(gc_sanitize_session_id 'back\slash')"
assert_eq "backslash stripped" "backslash" "$result"

# 15. Non-ASCII stripped
result="$(gc_sanitize_session_id "café")"
assert_eq "non-ASCII stripped: café -> caf" "caf" "$result"

# 16. Determinism: same input -> same output
result1="$(gc_sanitize_session_id "test-input")"
result2="$(gc_sanitize_session_id "test-input")"
assert_eq "determinism: identical results" "$result1" "$result2"

# 17. No argument at all -> unknown-{uuid}
result="$(gc_sanitize_session_id)"
if [[ "$result" =~ ^unknown-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  PASS=$((PASS + 1))
  printf "  PASS: %s\n" "no argument -> unknown-{uuid}"
else
  FAIL=$((FAIL + 1))
  printf "  FAIL: %s\n" "no argument -> unknown-{uuid}"
  printf "    actual:   '%s'\n" "$result"
fi

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi

exit 0
