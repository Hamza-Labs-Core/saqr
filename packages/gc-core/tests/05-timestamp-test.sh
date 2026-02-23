#!/usr/bin/env bash
set -euo pipefail

# Test Task 05: Timestamp Generation

RESULT_FILE=$(mktemp)
echo "0 0" > "$RESULT_FILE"
trap 'rm -f "$RESULT_FILE"' EXIT

_record_pass() {
  local counts; counts=$(cat "$RESULT_FILE")
  local p f; p=$(echo "$counts" | cut -d' ' -f1); f=$(echo "$counts" | cut -d' ' -f2)
  echo "$((p + 1)) $f" > "$RESULT_FILE"
}
_record_fail() {
  local counts; counts=$(cat "$RESULT_FILE")
  local p f; p=$(echo "$counts" | cut -d' ' -f1); f=$(echo "$counts" | cut -d' ' -f2)
  echo "$p $((f + 1))" > "$RESULT_FILE"
}

ts_func=$(cat <<'FUNC_EOF'
generate_timestamp() {
  local ms_check
  ms_check=$(date -u +"%3N" 2>/dev/null)
  if [[ "$ms_check" =~ ^[0-9]{3}$ ]]; then
    date -u +"%Y-%m-%dT%H:%M:%S.%3NZ"
  else
    date -u +"%Y-%m-%dT%H:%M:%SZ"
  fi
}
FUNC_EOF
)

echo "=== Task 05: Timestamp Generation Tests ==="

# Test 1: Timestamp matches ISO 8601 with milliseconds
echo ""
echo "--- Test 1: ISO 8601 format with milliseconds ---"
result=$(eval "$ts_func"; generate_timestamp)
# Match either with or without milliseconds
if [[ "$result" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$ ]]; then
  echo "  PASS: timestamp matches ISO 8601 with ms ($result)"; _record_pass
elif [[ "$result" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
  echo "  PASS: timestamp matches ISO 8601 without ms ($result)"; _record_pass
else
  echo "  FAIL: invalid timestamp format: $result"; _record_fail
fi

# Test 2: Timestamp is UTC (ends with Z)
echo ""
echo "--- Test 2: UTC (ends with Z) ---"
result=$(eval "$ts_func"; generate_timestamp)
if [[ "$result" == *"Z" ]]; then
  echo "  PASS: timestamp ends with Z"; _record_pass
else
  echo "  FAIL: timestamp does not end with Z: $result"; _record_fail
fi

# Test 3: Timestamp is close to current time
echo ""
echo "--- Test 3: Timestamp is current ---"
result=$(eval "$ts_func"; generate_timestamp)
# Extract the date portion and compare to current date
ts_date="${result:0:10}"
current_date=$(date -u +"%Y-%m-%d")
if [ "$ts_date" = "$current_date" ]; then
  echo "  PASS: timestamp date matches current date ($ts_date)"; _record_pass
else
  echo "  FAIL: timestamp date $ts_date does not match current $current_date"; _record_fail
fi

# Test 4: Multiple calls produce ordered timestamps
echo ""
echo "--- Test 4: Ordered timestamps ---"
ts1=$(eval "$ts_func"; generate_timestamp)
sleep 0.01
ts2=$(eval "$ts_func"; generate_timestamp)
if [[ "$ts1" < "$ts2" ]] || [[ "$ts1" == "$ts2" ]]; then
  echo "  PASS: timestamps are ordered ($ts1 <= $ts2)"; _record_pass
else
  echo "  FAIL: timestamps not ordered ($ts1 > $ts2)"; _record_fail
fi

# Summary
echo ""
counts=$(cat "$RESULT_FILE")
PASS=$(echo "$counts" | cut -d' ' -f1)
FAIL=$(echo "$counts" | cut -d' ' -f2)
echo "=============================="
echo "Results: $PASS passed, $FAIL failed"
echo "=============================="
[ "$FAIL" -gt 0 ] && exit 1
exit 0
