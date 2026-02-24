#!/usr/bin/env bash
# run-all.sh — Run all gc-core tests (bash unit + Node.js projection tests)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0
ERRORS=()

echo "=== gc-core test suite ==="
echo ""

# Run bash lib tests
echo "--- lib/ tests ---"
for t in "$SCRIPT_DIR"/lib/*.sh; do
  name="$(basename "$t")"
  if bash "$t" >/dev/null 2>&1; then
    echo "  PASS  $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $name"
    FAIL=$((FAIL + 1))
    ERRORS+=("lib/$name")
  fi
done

# Run bash bin tests
echo ""
echo "--- bin/ tests ---"
for t in "$SCRIPT_DIR"/bin/*.sh; do
  name="$(basename "$t")"
  if bash "$t" >/dev/null 2>&1; then
    echo "  PASS  $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $name"
    FAIL=$((FAIL + 1))
    ERRORS+=("bin/$name")
  fi
done

# Run bash integration tests
echo ""
echo "--- integration/ tests ---"
for t in "$SCRIPT_DIR"/integration/*.sh; do
  name="$(basename "$t")"
  if bash "$t" >/dev/null 2>&1; then
    echo "  PASS  $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $name"
    FAIL=$((FAIL + 1))
    ERRORS+=("integration/$name")
  fi
done

# Run codeguard tests
echo ""
echo "--- codeguard/ tests ---"
for t in "$SCRIPT_DIR"/codeguard/*.sh; do
  name="$(basename "$t")"
  if bash "$t" >/dev/null 2>&1; then
    echo "  PASS  $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $name"
    FAIL=$((FAIL + 1))
    ERRORS+=("codeguard/$name")
  fi
done

# Run Node.js projection tests
echo ""
echo "--- projections/ tests ---"
if node "$SCRIPT_DIR/projections/run-all.mjs" >/dev/null 2>&1; then
  echo "  PASS  projections/run-all.mjs"
  PASS=$((PASS + 1))
else
  echo "  FAIL  projections/run-all.mjs"
  FAIL=$((FAIL + 1))
  ERRORS+=("projections/run-all.mjs")
fi

# Summary
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  echo "Failures:"
  for e in "${ERRORS[@]}"; do
    echo "  - $e"
  done
  exit 1
fi
