#!/usr/bin/env bash
# version.sh -- Version detection and comparison functions for GlobalContext.
# Used by gc-install to decide whether to upgrade, skip, or warn about downgrade.
set -euo pipefail

# ---------------------------------------------------------------------------
# gc_get_installed_version(gc_base) -> version string
#   Returns the installed version, or "0.0.0" if not installed.
# ---------------------------------------------------------------------------
gc_get_installed_version() {
  local gc_base="$1"
  if [ -f "$gc_base/VERSION" ]; then
    tr -d '[:space:]' < "$gc_base/VERSION"
  else
    echo "0.0.0"
  fi
}

# ---------------------------------------------------------------------------
# gc_get_available_version(src_dir) -> version string
#   Returns the available version from the repository, or "unknown".
# ---------------------------------------------------------------------------
gc_get_available_version() {
  local src_dir="$1"
  # Try repo layout first (src/../VERSION), then installed layout (store/VERSION)
  local version_file="$src_dir/../VERSION"
  if [ -f "$version_file" ]; then
    tr -d '[:space:]' < "$version_file"
  elif [ -f "$src_dir/VERSION" ]; then
    tr -d '[:space:]' < "$src_dir/VERSION"
  else
    echo "unknown"
  fi
}

# ---------------------------------------------------------------------------
# gc_version_compare(installed, available) -> "same"|"upgrade"|"downgrade"|"unknown"
# ---------------------------------------------------------------------------
gc_version_compare() {
  local installed="$1"
  local available="$2"

  if [ "$installed" = "$available" ]; then
    echo "same"
    return
  fi

  if [ "$installed" = "0.0.0" ] || [ "$available" = "unknown" ]; then
    echo "upgrade"
    return
  fi

  # Numeric comparison of semver components
  local i_major i_minor i_patch a_major a_minor a_patch
  IFS='.' read -r i_major i_minor i_patch <<< "$installed"
  IFS='.' read -r a_major a_minor a_patch <<< "$available"

  # Default patch to 0 if missing
  i_patch="${i_patch:-0}"
  a_patch="${a_patch:-0}"

  if [ "$a_major" -gt "$i_major" ] 2>/dev/null ||
     { [ "$a_major" -eq "$i_major" ] && [ "$a_minor" -gt "$i_minor" ]; } 2>/dev/null ||
     { [ "$a_major" -eq "$i_major" ] && [ "$a_minor" -eq "$i_minor" ] && [ "$a_patch" -gt "$i_patch" ]; } 2>/dev/null; then
    echo "upgrade"
  else
    echo "downgrade"
  fi
}
