#!/usr/bin/env bash
# config.sh -- Config file (config.json) creation, reading, and validation
# for GlobalContext. Config is created once during init and never overwritten.
set -euo pipefail

# Source paths.sh for shared constants (GC_ROOT, GC_CONFIG_FILE)
_CONFIG_SH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "${_CONFIG_SH_DIR}/paths.sh"
# shellcheck source=atomic_write.sh
source "${_CONFIG_SH_DIR}/atomic_write.sh"

# ---------------------------------------------------------------------------
# Default config values (hardcoded fallbacks)
# ---------------------------------------------------------------------------
_GC_DEFAULT_VERSION="1.0.0"
_GC_DEFAULT_CHECKSUM="false"

# ---------------------------------------------------------------------------
# gc_config_create()
#
# Writes default config.json (via atomic write) if the file does not exist.
# If the file already exists, it is NOT overwritten (preserves custom fields).
# Returns 0 on success, 1 on failure.
# ---------------------------------------------------------------------------
gc_config_create() {
  # If config already exists, do nothing
  if [[ -f "$GC_CONFIG_FILE" ]]; then
    return 0
  fi

  local created_at
  created_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  local config_json
  config_json=$(jq -n \
    --arg version "$_GC_DEFAULT_VERSION" \
    --arg created_at "$created_at" \
    --arg storage_path "$GC_ROOT" \
    --argjson checksum false \
    '{
      version: $version,
      created_at: $created_at,
      storage_path: $storage_path,
      checksum: $checksum
    }')

  gc_atomic_write "$GC_CONFIG_FILE" "$config_json"
}

# ---------------------------------------------------------------------------
# gc_config_read(field) -> value
#
# Reads a single field from config.json using jq.
# - If config.json does not exist: prints error and exits 1.
# - If config.json is unparseable: prints error and exits 1.
# - If the requested field is missing: returns the hardcoded default value.
# ---------------------------------------------------------------------------
gc_config_read() {
  local field="${1:?gc_config_read: field argument required}"

  # Check config exists
  if [[ ! -f "$GC_CONFIG_FILE" ]]; then
    echo "GlobalContext store not initialized. Run gc-init." >&2
    return 1
  fi

  # Try to parse and extract the field
  local raw_value
  if ! raw_value=$(jq -e "." "$GC_CONFIG_FILE" 2>/dev/null); then
    echo "config.json is corrupt" >&2
    return 1
  fi

  # Extract the specific field
  local value
  value=$(jq -r ".$field // empty" "$GC_CONFIG_FILE" 2>/dev/null)

  if [[ -z "$value" ]]; then
    # Field missing -- return hardcoded default
    case "$field" in
      version)
        printf '%s' "$_GC_DEFAULT_VERSION"
        ;;
      storage_path)
        printf '%s' "$GC_ROOT"
        ;;
      checksum)
        printf '%s' "$_GC_DEFAULT_CHECKSUM"
        ;;
      *)
        # No default for unknown fields, return empty
        printf ''
        ;;
    esac
  else
    printf '%s' "$value"
  fi
}

# ---------------------------------------------------------------------------
# gc_config_validate() -> 0 or 1
#
# Checks that config.json exists, is valid JSON, and contains all required
# fields (version, created_at, storage_path, checksum).
# Returns 0 if valid, 1 if not.
# ---------------------------------------------------------------------------
gc_config_validate() {
  # Check file exists
  if [[ ! -f "$GC_CONFIG_FILE" ]]; then
    return 1
  fi

  # Check valid JSON
  if ! jq -e "." "$GC_CONFIG_FILE" >/dev/null 2>&1; then
    return 1
  fi

  # Check all required fields exist
  local required_fields=("version" "created_at" "storage_path" "checksum")
  for field in "${required_fields[@]}"; do
    if ! jq -e "has(\"$field\")" "$GC_CONFIG_FILE" 2>/dev/null | grep -q "true"; then
      return 1
    fi
  done

  return 0
}
