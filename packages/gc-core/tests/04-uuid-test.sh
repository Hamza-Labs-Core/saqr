#!/usr/bin/env bash
set -euo pipefail

# Test Task 04: UUID v4 Generation

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

UUID_REGEX='^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

uuid_func=$(cat <<'FUNC_EOF'
generate_uuid() {
  if command -v uuidgen &>/dev/null; then
    uuidgen | tr 'A-F' 'a-f'
    return
  fi
  if [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
    return
  fi
  printf '%04x%04x-%04x-%04x-%04x-%04x%04x%04x' \
    $RANDOM $RANDOM \
    $RANDOM \
    $(( (RANDOM & 0x0FFF) | 0x4000 )) \
    $(( (RANDOM & 0x3FFF) | 0x8000 )) \
    $RANDOM $RANDOM $RANDOM
}
FUNC_EOF
)

echo "=== Task 04: UUID Generation Tests ==="

# Test 1: With uuidgen available
echo ""
echo "--- Test 1: uuidgen tier ---"
result=$(eval "$uuid_func"; generate_uuid)
if [[ "$result" =~ $UUID_REGEX ]]; then
  echo "  PASS: uuidgen produces valid UUID v4 ($result)"; _record_pass
else
  echo "  FAIL: invalid UUID from uuidgen: $result"; _record_fail
fi

# Test 2: UUID is lowercase
echo ""
echo "--- Test 2: Lowercase ---"
result=$(eval "$uuid_func"; generate_uuid)
lowercase=$(echo "$result" | tr 'A-F' 'a-f')
if [ "$result" = "$lowercase" ]; then
  echo "  PASS: UUID is lowercase"; _record_pass
else
  echo "  FAIL: UUID has uppercase chars: $result"; _record_fail
fi

# Test 3: With uuidgen removed, /proc fallback
echo ""
echo "--- Test 3: /proc fallback ---"
if [ -r /proc/sys/kernel/random/uuid ]; then
  result=$(
    # Shadow uuidgen by using a PATH that doesn't contain it
    generate_uuid() {
      if [ -r /proc/sys/kernel/random/uuid ]; then
        cat /proc/sys/kernel/random/uuid
        return
      fi
      printf '%04x%04x-%04x-%04x-%04x-%04x%04x%04x' \
        $RANDOM $RANDOM $RANDOM \
        $(( (RANDOM & 0x0FFF) | 0x4000 )) \
        $(( (RANDOM & 0x3FFF) | 0x8000 )) \
        $RANDOM $RANDOM $RANDOM
    }
    generate_uuid
  )
  if [[ "$result" =~ $UUID_REGEX ]]; then
    echo "  PASS: /proc fallback produces valid UUID ($result)"; _record_pass
  else
    echo "  FAIL: invalid UUID from /proc: $result"; _record_fail
  fi
else
  echo "  SKIP: /proc/sys/kernel/random/uuid not available"; _record_pass
fi

# Test 4: Bash-native fallback
echo ""
echo "--- Test 4: Bash-native fallback ---"
result=$(
  generate_uuid_native() {
    printf '%04x%04x-%04x-%04x-%04x-%04x%04x%04x' \
      $RANDOM $RANDOM \
      $RANDOM \
      $(( (RANDOM & 0x0FFF) | 0x4000 )) \
      $(( (RANDOM & 0x3FFF) | 0x8000 )) \
      $RANDOM $RANDOM $RANDOM
  }
  generate_uuid_native
)
if [[ "$result" =~ $UUID_REGEX ]]; then
  echo "  PASS: bash-native fallback produces valid UUID v4 ($result)"; _record_pass
else
  echo "  FAIL: invalid UUID from bash-native: $result"; _record_fail
fi

# Test 5: 100 UUIDs with no duplicates
echo ""
echo "--- Test 5: No duplicates in 100 calls ---"
uuids=$(for i in $(seq 1 100); do eval "$uuid_func"; generate_uuid; done)
unique_count=$(echo "$uuids" | sort -u | wc -l)
if [ "$unique_count" -eq 100 ]; then
  echo "  PASS: 100 unique UUIDs generated"; _record_pass
else
  echo "  FAIL: expected 100 unique, got $unique_count"; _record_fail
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
