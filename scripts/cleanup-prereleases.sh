#!/usr/bin/env bash
set -euo pipefail

# cleanup-prereleases.sh — Keep only the N most recent prereleases
#
# Usage:
#   scripts/cleanup-prereleases.sh --keep 5
#
# Requires: gh CLI + GITHUB_TOKEN

KEEP=5

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)
      KEEP="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

echo "Keeping the $KEEP most recent prereleases"

# List all prereleases sorted by date (newest first)
# gh release list outputs: title, type (Pre-release/Latest/Draft), tag, date
PRERELEASES=()
while IFS=$'\t' read -r _title type tag _date; do
  if [[ "$type" == "Pre-release" ]]; then
    PRERELEASES+=("$tag")
  fi
done < <(gh release list --exclude-drafts --limit 100 2>/dev/null || true)

TOTAL=${#PRERELEASES[@]}
echo "Found $TOTAL prereleases"

if [[ $TOTAL -le $KEEP ]]; then
  echo "Nothing to clean up"
  exit 0
fi

# Delete oldest prereleases beyond the keep count
# Array is newest-first, so slice from index $KEEP onward
for (( i=KEEP; i<TOTAL; i++ )); do
  TAG="${PRERELEASES[$i]}"
  echo "Deleting prerelease: $TAG"
  gh release delete "$TAG" --yes --cleanup-tag 2>/dev/null || true
done

DELETED=$(( TOTAL - KEEP ))
echo "Cleaned up $DELETED old prereleases"
