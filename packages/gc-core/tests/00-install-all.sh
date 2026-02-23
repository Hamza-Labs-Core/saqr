#!/usr/bin/env bash
set -euo pipefail

# 00-install-all.sh -- Runner script for all Story 00 installation integration tests

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

TOTAL_PASS=0
TOTAL_FAIL=0
SUITES_PASS=0
SUITES_FAIL=0
FAILED_SUITES=()

run_suite() {
  local name="$1"
  local script="$2"
  echo "================================================================"
  echo "Running: $name"
  echo "================================================================"
  if bash "$script"; then
    SUITES_PASS=$((SUITES_PASS + 1))
  else
    SUITES_FAIL=$((SUITES_FAIL + 1))
    FAILED_SUITES+=("$name")
  fi
  echo ""
}

# Run all integration test suites
run_suite "Fresh Install" "$SCRIPT_DIR/00-install-fresh.sh"
run_suite "Upgrade" "$SCRIPT_DIR/00-install-upgrade.sh"
run_suite "Uninstall" "$SCRIPT_DIR/00-install-uninstall.sh"
run_suite "Edge Cases" "$SCRIPT_DIR/00-install-edge-cases.sh"

# Also run unit tests
echo "================================================================"
echo "Running unit test suites..."
echo "================================================================"
echo ""

for test_file in "$SCRIPT_DIR/lib/test_prerequisites.sh" \
                 "$SCRIPT_DIR/lib/test_version.sh" \
                 "$SCRIPT_DIR/lib/test_deploy.sh" \
                 "$SCRIPT_DIR/bin/test_gc_install_script.sh" \
                 "$SCRIPT_DIR/bin/test_gc_uninstall.sh" \
                 "$SCRIPT_DIR/bin/test_gc_doctor.sh" \
                 "$SCRIPT_DIR/bin/test_gc_install_hooks_integration.sh"; do
  if [ -f "$test_file" ]; then
    name=$(basename "$test_file" .sh)
    run_suite "$name" "$test_file"
  fi
done

echo ""
echo "================================================================"
echo "OVERALL SUMMARY"
echo "================================================================"
echo "Suites passed: $SUITES_PASS"
echo "Suites failed: $SUITES_FAIL"
if [ ${#FAILED_SUITES[@]} -gt 0 ]; then
  echo "Failed suites:"
  for s in "${FAILED_SUITES[@]}"; do
    echo "  - $s"
  done
fi
echo "================================================================"

if [ "$SUITES_FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
