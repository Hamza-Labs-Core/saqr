#!/usr/bin/env bash
set -euo pipefail

# changelog.sh — Generate a grouped changelog since the last tag
#
# Usage:
#   scripts/changelog.sh --since <tag>    → changes since that tag
#   scripts/changelog.sh                  → changes since the latest tag
#
# Output: Markdown changelog to stdout, grouped by conventional commit type.

SINCE_TAG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --since)
      SINCE_TAG="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# Find the reference tag
if [[ -z "$SINCE_TAG" ]]; then
  SINCE_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
fi

# Collect PR titles merged since the tag
if [[ -n "$SINCE_TAG" ]]; then
  SINCE_DATE=$(git log -1 --format=%aI "$SINCE_TAG" 2>/dev/null || echo "")
else
  SINCE_DATE=""
fi

FEATURES=()
FIXES=()
DOCS=()
OTHER=()

# Try merged PRs first (requires gh CLI + GITHUB_TOKEN)
if command -v gh &>/dev/null && [[ -n "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ]]; then
  PR_ARGS=(pr list --state merged --base main --json title --jq '.[].title' --limit 100)
  if [[ -n "$SINCE_DATE" ]]; then
    PR_ARGS+=(--search "merged:>=${SINCE_DATE%%T*}")
  fi

  while IFS= read -r title; do
    [[ -z "$title" ]] && continue
    lower=$(echo "$title" | tr '[:upper:]' '[:lower:]')
    case "$lower" in
      feat*)            FEATURES+=("$title") ;;
      fix*)             FIXES+=("$title") ;;
      doc*)             DOCS+=("$title") ;;
      *)                OTHER+=("$title") ;;
    esac
  done < <(gh "${PR_ARGS[@]}" 2>/dev/null || true)
fi

# Fallback to commit summaries if no PRs found
if [[ ${#FEATURES[@]} -eq 0 && ${#FIXES[@]} -eq 0 && ${#DOCS[@]} -eq 0 && ${#OTHER[@]} -eq 0 ]]; then
  if [[ -n "$SINCE_TAG" ]]; then
    RANGE="${SINCE_TAG}..HEAD"
  else
    RANGE="HEAD~20..HEAD"
  fi

  while IFS= read -r msg; do
    [[ -z "$msg" ]] && continue
    lower=$(echo "$msg" | tr '[:upper:]' '[:lower:]')
    case "$lower" in
      feat*)            FEATURES+=("$msg") ;;
      fix*)             FIXES+=("$msg") ;;
      doc*)             DOCS+=("$msg") ;;
      *)                OTHER+=("$msg") ;;
    esac
  done < <(git log --pretty=format:"%s" "$RANGE" 2>/dev/null || true)
fi

# Output grouped markdown
if [[ ${#FEATURES[@]} -gt 0 ]]; then
  echo "### Features"
  echo ""
  for item in "${FEATURES[@]}"; do
    echo "- $item"
  done
  echo ""
fi

if [[ ${#FIXES[@]} -gt 0 ]]; then
  echo "### Fixes"
  echo ""
  for item in "${FIXES[@]}"; do
    echo "- $item"
  done
  echo ""
fi

if [[ ${#DOCS[@]} -gt 0 ]]; then
  echo "### Docs"
  echo ""
  for item in "${DOCS[@]}"; do
    echo "- $item"
  done
  echo ""
fi

if [[ ${#OTHER[@]} -gt 0 ]]; then
  echo "### Other"
  echo ""
  for item in "${OTHER[@]}"; do
    echo "- $item"
  done
  echo ""
fi

# If absolutely nothing found, note it
if [[ ${#FEATURES[@]} -eq 0 && ${#FIXES[@]} -eq 0 && ${#DOCS[@]} -eq 0 && ${#OTHER[@]} -eq 0 ]]; then
  echo "- No notable changes"
  echo ""
fi
