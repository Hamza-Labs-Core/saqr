#!/usr/bin/env bash
set -euo pipefail

# version.sh — Compute and apply version strings for CI builds
#
# Usage:
#   scripts/version.sh --pr <N>     → prerelease: 0.1.{build}-pr.{N}
#   scripts/version.sh              → release:    0.1.{build}
#
# Requires GITHUB_RUN_NUMBER (set by GitHub Actions) or --build <N> override.
# Writes version to $GITHUB_OUTPUT if available.

PR_NUMBER=""
BUILD_NUMBER="${GITHUB_RUN_NUMBER:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pr)
      PR_NUMBER="$2"
      shift 2
      ;;
    --build)
      BUILD_NUMBER="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$BUILD_NUMBER" ]]; then
  echo "Error: GITHUB_RUN_NUMBER not set and --build not provided" >&2
  exit 1
fi

# Construct version
if [[ -n "$PR_NUMBER" ]]; then
  VERSION="0.1.${BUILD_NUMBER}-pr.${PR_NUMBER}"
else
  VERSION="0.1.${BUILD_NUMBER}"
fi

echo "Version: $VERSION"

# Update root package.json
ROOT_PKG="$(git rev-parse --show-toplevel)/package.json"
if [[ -f "$ROOT_PKG" ]]; then
  tmp=$(mktemp)
  jq --arg v "$VERSION" '.version = $v' "$ROOT_PKG" > "$tmp" && mv "$tmp" "$ROOT_PKG"
  echo "Updated $ROOT_PKG"
fi

# Update mobile app.json
APP_JSON="$(git rev-parse --show-toplevel)/packages/mobile/app.json"
if [[ -f "$APP_JSON" ]]; then
  tmp=$(mktemp)
  jq --arg v "$VERSION" --arg bn "$BUILD_NUMBER" \
    '.expo.version = $v | .expo.ios.buildNumber = $bn | .expo.android.versionCode = ($bn | tonumber)' \
    "$APP_JSON" > "$tmp" && mv "$tmp" "$APP_JSON"
  echo "Updated $APP_JSON"
fi

# Update desktop tauri.conf.json
TAURI_CONF="$(git rev-parse --show-toplevel)/packages/desktop/src-tauri/tauri.conf.json"
if [[ -f "$TAURI_CONF" ]]; then
  tmp=$(mktemp)
  jq --arg v "$VERSION" '.version = $v' "$TAURI_CONF" > "$tmp" && mv "$tmp" "$TAURI_CONF"
  echo "Updated $TAURI_CONF"
fi

# Update desktop Cargo.toml
CARGO_TOML="$(git rev-parse --show-toplevel)/packages/desktop/src-tauri/Cargo.toml"
if [[ -f "$CARGO_TOML" ]]; then
  # Replace version in [package] section only (first occurrence)
  sed -i "0,/^version = \".*\"/s//version = \"$VERSION\"/" "$CARGO_TOML"
  echo "Updated $CARGO_TOML"
fi

# Write to GitHub Actions output
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "version=$VERSION" >> "$GITHUB_OUTPUT"
  echo "build_number=$BUILD_NUMBER" >> "$GITHUB_OUTPUT"
fi
